"""Dynamic provider model-list refresh with change detection.

minAgent already caches each provider's ``/models`` catalog on disk
(``provider_models_cache.json``) and refreshes stale entries through
stale-while-revalidate (SWR) threads. This module adds the *missing* piece:
when a refresh actually changes a provider's model IDs, it records a revision
and writes it to ``model_catalog_revision.json``.

Pickers read that file to notice the change without a gateway restart:

* The desktop app polls ``GET /api/model/options?rev=`` and refetches when the
  revision moves (see apps/desktop/src/lib/model-options.ts).
* The CLI / terminal pickers rebuild their rows from the freshly cached list
  on the next open (already SWR-aware).

The detector is deliberately cheap and fail-soft:

* It inspects only the entries already being refreshed — no extra network.
* A failed probe leaves the cached IDs untouched, so a transient outage never
  looks like "all models were removed".
* The revision file is written atomically, under the same cross-process lock
  used for the catalog cache, so concurrent gateway/CLI writers cannot tear it.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _hermes_home() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home()


def revision_path() -> Path:
    return _hermes_home() / "model_catalog_revision.json"


def read_revision() -> dict[str, int]:
    """Current ``{provider: revision}`` mapping, or ``{}`` on any read error."""
    path = revision_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, int] = {}
    for key, value in data.items():
        try:
            out[str(key)] = int(value)
        except (TypeError, ValueError):
            continue
    return out


def total_revision() -> int:
    """A single number that changes whenever any provider's catalog changes."""
    return sum(read_revision().values())


def note_catalog_change(provider: str, old_models: Any, new_models: Any) -> bool:
    """Bump *provider*'s revision when its model-id set changes.

    ``old_models`` and ``new_models`` are the cached and freshly fetched ID
    lists. Comparison is order-insensitive and de-duplicating: re-ordering the
    same models (common on aggregators) is not a catalog change. Returns True
    when the revision was bumped.

    Call this from the disk-cache write path (see the patch in models.py) so it
    runs exactly where a new catalog is admitted.
    """
    try:
        old = {str(m) for m in (old_models or [])}
    except TypeError:
        old = set()
    try:
        new = {str(m) for m in (new_models or [])}
    except TypeError:
        new = set()
    if old == new:
        return False
    return bump_revision(provider)


def bump_revision(provider: str, *, delta: int = 1) -> bool:
    """Atomically increment *provider*'s revision. Safe across processes."""
    from hermes_cli.models_cache_lock import write_under_cache_lock

    path = revision_path()
    changed = False

    def _write() -> None:
        nonlocal changed
        data = read_revision()
        data[provider] = data.get(provider, 0) + delta
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, sort_keys=True), encoding="utf-8")
        tmp.replace(path)
        changed = True

    try:
        write_under_cache_lock(path, _write)
    except Exception:
        logger.debug("model catalog revision write failed (%s)", provider, exc_info=True)
        return False
    return changed


def refresh_configured_custom_providers(*, timeout: float = 15.0) -> dict[str, list[str]]:
    """Force a live catalog refresh for every configured custom provider.

    Uses :func:`cached_provider_model_ids` with ``force_refresh=True`` so the
    result lands under the SAME normalized slug the picker reads. That function
    already resolves ``key_cmd`` credentials and writes through
    :func:`_store_cache_entry`, where :func:`note_catalog_change` detects the
    change and bumps the revision. Failed probes leave the cached row untouched
    (the store only accepts non-empty lists), so an outage is not mistaken for
    "all models removed".

    Returns ``{slug: model_ids}`` for providers that answered.
    """
    from hermes_cli.config import get_compatible_custom_providers, load_config_readonly
    from hermes_cli.models import _load_provider_models_cache, cached_provider_model_ids
    from hermes_cli.providers import custom_provider_slug

    cfg = load_config_readonly()
    result: dict[str, list[str]] = {}
    cache = _load_provider_models_cache()

    def _is_fresh(slug: str) -> bool:
        entry = cache.get(slug)
        if not isinstance(entry, dict) or not isinstance(entry.get("at"), (int, float)):
            return False
        # 1h TTL matches _PROVIDER_MODELS_CACHE_TTL; a freshly cached catalog
        # needs no probe on every watcher pass.
        return (time.time() - float(entry["at"])) < 3600

    def _probe(slug: str, box: dict) -> None:
        try:
            box["models"] = cached_provider_model_ids(slug, force_refresh=True)
        except Exception:
            box["models"] = []

    for info in get_compatible_custom_providers(cfg) or []:
        api = str(info.get("api") or info.get("base_url") or info.get("url") or "").strip()
        if not api:
            continue
        slug = custom_provider_slug(info.get("name") or "custom", info.get("provider_key") or "")
        if _is_fresh(slug):
            continue
        # Some native catalog fetchers (e.g. DashScope) can hang beyond the
        # injected `timeout`. Keep the watcher responsive with a hard deadline:
        # a timed-out probe is abandoned (daemon thread) and simply retried next pass.
        box: dict[str, list[str]] = {}
        worker = threading.Thread(target=_probe, args=(slug, box), daemon=True,
                                  name=f"model-refresh-{slug}")
        worker.start()
        worker.join(timeout)
        if not worker.is_alive() and box.get("models"):
            result[slug] = list(box["models"])
        elif worker.is_alive():
            logger.debug("custom provider catalog refresh timed out (%s)", slug)
    return result
