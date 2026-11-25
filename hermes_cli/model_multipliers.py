"""Model credit multipliers (倍率) — display-only metadata for pickers and status bars.

A multiplier says how many credits a model costs relative to a 1x basis. It is
*never* used for routing or billing: this module only produces labels such as
``0.6X`` that pickers draw right-aligned after the model name, and that the CLI
input window draws beside the selected model.

Sources, in precedence order (first hit wins per model):

1. ``model_multipliers`` in config.yaml — an explicit user override, keyed by
   bare model id or ``provider:model`` (``custom:codebuddy:hy4flash-free``).
2. Provider-specific discovery. Currently:

   * CodeBuddy CN — its local product config (``Tencent-Cloud.coding-copilot``
     in CodeBuddy's VS Code ``state.vscdb``) carries a per-model ``credits``
     string like ``x0.29``. Read-only; no credentials are touched here.
   * DashScope/Qwen — :mod:`hermes_cli.qwen_catalog` derives Token-套餐
     multipliers from the models.dev registry.
   * Any provider with price data — ``price_multipliers`` relative to the
     cheapest non-free priced model (see ``hermes_cli.inventory``).

3. Nothing — the model gets no multiplier badge at all.

Discovery is cached in-process with a short TTL and degrades silently: a
missing CodeBuddy install, an unreadable config, or a broken registry must
never break a picker.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

logger = logging.getLogger(__name__)

_DISCOVERY_TTL = 300.0  # 5 minutes — product configs are refreshed by their own apps

_discovery_cache: dict[str, tuple[float, dict[str, float]]] = {}


def format_multiplier(value: Any) -> str:
    """``0.6`` → ``"0.6X"``, ``1`` → ``"1X"``, ``10.82`` → ``"10.8X"``.

    Empty string for anything non-positive or unparseable, so callers can
    simply skip the badge when this returns nothing.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return ""
    if number <= 0 or number != number:  # NaN
        return ""
    text = f"{number:.2f}".rstrip("0").rstrip(".")
    return f"{text}X"


def _cached(name: str, discover):
    """Return a discovery dict, refreshing at most once per TTL window."""
    now = time.monotonic()
    hit = _discovery_cache.get(name)
    if hit is not None and now - hit[0] < _DISCOVERY_TTL:
        return hit[1]
    try:
        result = discover() or {}
    except Exception:
        result = {}
        logger.debug("model multiplier discovery failed (%s)", name, exc_info=True)
    _discovery_cache[name] = (now, result)
    return result


def _config_path() -> Optional[Path]:
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home() / "config.yaml"
    except Exception:
        return None


def config_multipliers() -> dict[str, float]:
    """Explicit ``model_multipliers: {model: value}`` from config.yaml."""
    path = _config_path()
    if path is None:
        return {}
    try:
        import yaml

        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    section = raw.get("model_multipliers") if isinstance(raw, dict) else None
    if not isinstance(section, dict):
        return {}
    out: dict[str, float] = {}
    for key, value in section.items():
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            out[str(key)] = number
    return out


def codebuddy_multipliers() -> dict[str, float]:
    """Per-model ``credits`` multipliers from CodeBuddy CN's local product config.

    The product config is plain JSON stored in the IDE's VS Code
    ``state.vscdb`` (``Tencent-Cloud.coding-copilot``). This reads that single
    value; it does not decrypt or touch any credential/session rows.
    """
    return _cached("codebuddy", _discover_codebuddy)


def _discover_codebuddy() -> dict[str, float]:
    import sqlite3

    home = os.environ.get("APPDATA")
    if not home:
        return {}
    db = Path(home) / "CodeBuddy CN" / "User" / "globalStorage" / "state.vscdb"
    if not db.exists():
        return {}
    uri = f"file:{db.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    try:
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key='Tencent-Cloud.coding-copilot'"
        ).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        return {}
    try:
        data = json.loads(row[0])
    except (TypeError, ValueError):
        return {}

    out: dict[str, float] = {}
    credit_re = re.compile(r"^x?\s*([0-9]+(?:\.[0-9]+)?)$", re.I)

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            mid = node.get("id")
            credits = node.get("credits")
            if isinstance(mid, str) and isinstance(credits, str):
                match = credit_re.match(credits.strip())
                if match:
                    try:
                        value = float(match.group(1))
                    except ValueError:
                        value = 0.0
                    if value > 0:
                        out[mid] = value
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(data)
    return out


def dashscope_multipliers() -> dict[str, float]:
    """Token-套餐 multipliers from the models.dev registry (Qwen/DashScope)."""
    return _cached("dashscope", _discover_dashscope)


def wps_lingxi_multipliers() -> dict[str, float]:
    """Per-model multipliers from WPS 灵犀's ``sessions/plans`` endpoint.

    WPS exposes its live model catalog together with a ``multiplier`` string
    like ``0.40x`` / ``～0.12x``. We read it read-only with the configured
    ``wps_sid`` cookie (no token is logged). Returns ``{}`` on any failure.
    """
    return _cached("wps_lingxi", _discover_wps_lingxi)


def _discover_wps_lingxi() -> dict[str, float]:
    try:
        from providers import get_provider_profile

        profile = get_provider_profile("wps_lingxi")
        if profile is None:
            return {}
        # Resolve the same key the picker uses without importing CLI internals.
        api_key = os.environ.get("WPS_LINGXI_SID") or os.environ.get("WPS_LINGXI_COOKIE") or ""
        if not api_key:
            path = _config_path()
            if path is not None:
                import yaml

                raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                entry = (raw.get("providers") or {}).get("wps_lingxi") or {}
                api_key = str(entry.get("api_key") or "")
        if not api_key:
            return {}
        from plugins.model_providers.wps_lingxi.transport import (
            MODELS_CACHE_PATH, UA, _cookie_parts,
        )
        import httpx

        cookie, _, _ = _cookie_parts(api_key)
        base = str(getattr(profile, "base_url", "") or "https://lingxi.kdocs.cn").rstrip("/")
        resp = httpx.get(
            base + MODELS_CACHE_PATH,
            headers={"Cookie": cookie, "User-Agent": UA, "Accept": "application/json"},
            timeout=6.0,
        )
        if resp.status_code != 200:
            return {}
        data = resp.json()
        models = (data.get("data") or {}).get("models") or []
        out: dict[str, float] = {}
        for model in models:
            if not isinstance(model, dict):
                continue
            key = model.get("key")
            mult = str(model.get("multiplier") or "").strip()
            match = re.search(r"([0-9]+(?:\.[0-9]+)?)", mult)
            if isinstance(key, str) and match:
                try:
                    value = float(match.group(1))
                except ValueError:
                    continue
                if value > 0:
                    out[key] = value
        return out
    except Exception:
        return {}


def _discover_dashscope() -> dict[str, float]:
    from hermes_cli.qwen_catalog import dashscope_token_multipliers

    return dashscope_token_multipliers() or {}


def apply_multipliers(
    rows: Iterable[dict],
    *,
    cached_only: bool = False,
) -> list[dict]:
    """Annotate picker rows with multiplier metadata, in place, and return them.

    Adds two fields to each row that has at least one multiplier:

    * ``model_multipliers`` — ``{model_id: float}``
    * ``model_multiplier_labels`` — ``{model_id: "0.6X"}``

    Existing ``token_multipliers`` / ``price_multipliers`` from
    ``hermes_cli.inventory`` are reused when present; this module fills the
    gaps (notably CodeBuddy) and merges everything under one key so every
    surface has a single field to render.
    """
    overrides = _cached("config", config_multipliers)
    codebuddy = codebuddy_multipliers()
    dashscope = dashscope_multipliers()
    wps = wps_lingxi_multipliers()

    annotated: list[dict] = []
    for row in rows:
        models = row.get("models") or []
        if not models:
            annotated.append(row)
            continue

        candidates: dict[str, float] = {}
        # Lowest precedence first so later sources win.
        for mid, value in (row.get("price_multipliers") or {}).items():
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if number > 0:
                candidates[str(mid)] = number
        candidates.update(dashscope)
        candidates.update(wps)
        candidates.update(row.get("token_multipliers") or {})
        candidates.update(codebuddy)

        merged: dict[str, float] = {}
        for mid in models:
            value: Optional[float] = None
            for key in (f"{row.get('slug', '')}:{mid}", mid):
                if key in overrides:
                    value = overrides[key]
                    break
            if value is None:
                value = candidates.get(mid)
            if value is not None and value > 0:
                merged[mid] = round(float(value), 3)

        if merged:
            row["model_multipliers"] = merged
            row["model_multiplier_labels"] = {
                mid: format_multiplier(value) for mid, value in merged.items()
            }
        annotated.append(row)
    return annotated


def all_labels() -> dict[str, str]:
    """Flat ``{bare_model_id: "0.6X"}`` across every discovered source.

    For surfaces that know only the model id (the terminal model picker and
    the CLI status bar), which do not have a provider row to consult. Explicit
    config overrides win; then CodeBuddy, then Qwen/DashScope (which can be
    large, so it is merged first).
    """
    merged: dict[str, float] = {}
    merged.update(_cached("dashscope", _discover_dashscope))
    merged.update(wps_lingxi_multipliers())
    merged.update(codebuddy_multipliers())
    overrides = _cached("config", config_multipliers)
    for key, value in overrides.items():
        merged[key.split(":", 1)[-1]] = value
    return {mid: format_multiplier(value) for mid, value in merged.items() if value > 0}


def multiplier_for(model: str, rows: Iterable[Mapping]) -> Optional[str]:
    """Formatted multiplier (``"0.6X"``) for *model* in already-annotated rows.

    Accepts bare ids and ``provider:model`` ids. Returns ``None`` when the
    model has no multiplier.
    """
    bare = model.split(":", 1)[-1] if ":" in model else model
    for row in rows:
        labels = row.get("model_multiplier_labels") or {}
        if model in labels:
            return labels[model]
        if bare in labels:
            return labels[bare]
    return None
