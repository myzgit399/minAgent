"""Per-model outbound proxy policy for model requests.

``model_proxy.url`` holds the optional proxy URL; ``model_proxy.models`` maps a
``provider::model`` (or bare model id) to a boolean. A model explicitly listed
there uses the configured proxy when true, and is forced direct when false.
Models with no entry keep the process-wide env policy
(HTTPS_PROXY/HTTP_PROXY/ALL_PROXY + NO_PROXY).
"""

from __future__ import annotations

from typing import Any, Optional

from utils import normalize_proxy_url

# Sentinel: an explicit "no proxy for this model", overriding env proxies.
FORCE_DIRECT = ""


def proxy_policy_signature() -> tuple:
    """Cheap fingerprint of the proxy policy file, for live client invalidation."""
    try:
        from hermes_cli.config import get_config_path

        stat = get_config_path().stat()
        return (stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns)
    except Exception:
        return ()


def model_proxy_key(provider: Any, model: Any) -> str:
    """Stable key matching the desktop preset format."""
    slug = str(provider or "").strip()
    name = str(model or "").strip()
    return f"{slug}::{name}" if slug and name else (name or slug)


def resolve_model_proxy(provider: Any = None, model: Any = None) -> Optional[str]:
    """Return the proxy override for one model.

    - ``None``: no per-model policy — keep the env-based proxy behavior.
    - ``""``: explicitly direct, even when a proxy env var is set.
    - non-empty URL: use this proxy for the model's requests.
    """
    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly()
        section = config.get("model_proxy")
    except Exception:
        return None
    if not isinstance(section, dict):
        return None

    raw_url = section.get("url")
    url = normalize_proxy_url(raw_url) if isinstance(raw_url, str) else None
    models = section.get("models")
    if not isinstance(models, dict) or not models:
        return None

    slug = str(provider or "").strip()
    name = str(model or "").strip()
    key = model_proxy_key(slug, name)
    candidates = [c for c in (key, name) if c]

    # A generic provider (`custom`) can be stored with its endpoint family in
    # the key, e.g. ``custom:deepseek::deepseek-flash``. Accept any provider
    # chain containing the live provider slug, but only after exact and bare
    # model keys have failed — explicit settings win over fuzzy ones.
    if slug and name:
        for candidate in models:
            candidate_slug, sep, candidate_model = str(candidate).rpartition("::")
            if sep and candidate_model == name and slug in candidate_slug.split(":"):
                if candidate not in candidates:
                    candidates.append(candidate)

    enabled: Optional[bool] = None
    for candidate in candidates:
        if candidate in models:
            value = models[candidate]
            enabled = value if isinstance(value, bool) else str(value).strip().lower() in ("1", "true", "yes", "on")
            break
    if enabled is None:
        return None
    return url if (enabled and url) else FORCE_DIRECT


def _provider_chain(agent: Any) -> list[str]:
    """Slugs to try for one agent's proxy policy, most specific first.

    A config-declared provider (``providers.gemini``) runs on the generic
    ``custom`` profile, so the live slug is ``custom`` while the operator's
    ``model_proxy`` key — and the desktop picker — use the endpoint family
    (``gemini::gemini-flash-latest``). Try both, plus the ``custom:gemini``
    chain form, so an explicit per-model policy is not silently lost.
    """
    chain: list[str] = []
    for slug in (getattr(agent, "provider", ""), getattr(agent, "requested_provider", "")):
        raw = str(slug or "").strip()
        if not raw:
            continue
        for candidate in (raw, raw.split(":", 1)[-1], raw.rsplit(":", 1)[-1]):
            candidate = candidate.strip()
            if candidate and candidate not in chain:
                chain.append(candidate)
    return chain


def agent_proxy_override(agent: Any) -> Optional[str]:
    """Resolve the override from an AIAgent's live route."""
    model = getattr(agent, "model", "")
    for provider in _provider_chain(agent):
        override = resolve_model_proxy(provider, model)
        if override is not None:
            return override
    return None
