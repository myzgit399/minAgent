"""DashScope (阿里云百炼 / Qwen) chat catalog + token-cost multipliers.

One source of truth for "which Qwen models exist" so the picker, the ``aliyun``
provider profile and the ``alibaba`` curated list cannot drift apart again.

Resolution order (cheapest first, network never required):

1. ``agent.models_dev.fetch_models_dev(allow_network=False)`` — the bundled
   models.dev registry (``alibaba-cn`` first, then the international/profile
   twins). This is what keeps ids such as ``qwen3.8-flash`` in the list without
   a release: the live DashScope ``/v1/models`` route only reports what one
   account is entitled to, and only when a key is configured.
2. ``_CURATED_ORDER`` below — a release-time floor used when the registry is
   missing, so the picker is never empty.

Multipliers: DashScope publishes no pricing from ``/v1/models``, so the picker
had a blank price column for every Qwen model. ``dashscope_token_multipliers``
derives a "token 倍数" per model from the registry's list prices, with the
cheapest chat model in the catalog fixed at ``1×`` — the same relative scale the
百炼 Token 套餐 quotes, and honest about its basis (``dashscope_multiplier_basis``
names the model that is ``1×``).
"""

from __future__ import annotations

import re
from typing import Any, Optional

# Not chat-completions models: image/video generation, speech, embeddings, rerank.
_NON_CHAT = re.compile(
    r"(image|wanx|\bwan\d|asr|tts|ocr|embedding|rerank|voice|video|-mt-|livetranslate|"
    r"deep-research|math|doc-turbo|character)",
    re.I,
)

# Recommended-first order. Anything in the registry but missing here follows it
# in registry order, so a newly released model still surfaces without a patch.
_CURATED_ORDER = (
    "qwen3.8-max", "qwen3.8-flash", "qwen3.8-omni-flash", "qwen3.8-max-preview",
    "qwen3.7-max", "qwen3.7-plus", "qwen3.7-flash",
    "qwen3.6-plus", "qwen3.6-flash", "qwen3.6-max-preview",
    "qwen3.5-plus", "qwen3.5-flash", "qwen3.5-397b-a17b", "qwen3.5-122b-a10b",
    "qwen-max", "qwen-plus", "qwen-flash", "qwen-turbo", "qwen-long",
    "qwen3-max", "qwen3-coder-plus", "qwen3-coder-flash", "qwen3-coder-next",
    "qwen3-vl-plus", "qwen3-vl-235b-a22b", "qwen3-vl-30b-a3b",
    "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2.7-code", "kimi-k2.6",
    "glm-5.2", "glm-5.1", "glm-5", "MiniMax-M2.5",
)

# Registry providers in precedence order: the mainland catalog is the superset
# the domestic endpoint serves; the plan twins add the entitlement-only ids.
_REGISTRY_PROVIDERS = (
    "alibaba-cn", "alibaba-token-plan-cn", "alibaba", "alibaba-token-plan",
)


def _registry(allow_network: bool = False) -> dict[str, Any]:
    try:
        from agent.models_dev import fetch_models_dev

        return fetch_models_dev(allow_network=allow_network) or {}
    except Exception:
        return {}


def _is_chat_model(model_id: str, entry: dict[str, Any]) -> bool:
    modalities = entry.get("modalities") or {}
    outputs = modalities.get("output") or []
    if outputs and "text" not in outputs:
        return False
    return not _NON_CHAT.search(model_id)


def dashscope_registry_models(*, allow_network: bool = False) -> dict[str, dict[str, Any]]:
    """Chat-capable DashScope ids → their registry entry, ordered for the picker."""
    registry = _registry(allow_network)
    found: dict[str, dict[str, Any]] = {}
    for provider_id in _REGISTRY_PROVIDERS:
        models = (registry.get(provider_id) or {}).get("models") or {}
        if not isinstance(models, dict):
            continue
        for model_id, entry in models.items():
            if not isinstance(entry, dict) or model_id in found:
                continue
            if _is_chat_model(model_id, entry):
                found[model_id] = entry
    if not found:
        return {}

    ordered: dict[str, dict[str, Any]] = {}
    for model_id in _CURATED_ORDER:
        if model_id in found:
            ordered[model_id] = found.pop(model_id)
    # Tool-calling models first — they are the ones an agent can actually use.
    for model_id, entry in sorted(
        found.items(), key=lambda kv: (not kv[1].get("tool_call", False),)
    ):
        ordered[model_id] = entry
    return ordered


def dashscope_chat_model_ids(*, allow_network: bool = False) -> list[str]:
    """Every chat model id the catalog knows, best picks first, else ``[]``."""
    return list(dashscope_registry_models(allow_network=allow_network))


def _per_token(value: Any) -> str:
    """$/Mtok (registry) → the per-token string OpenRouter-shaped pricing uses."""
    try:
        per_mtok = float(value)
    except (TypeError, ValueError):
        return ""
    if per_mtok <= 0:
        return ""
    return f"{per_mtok / 1_000_000:.12f}".rstrip("0")


def dashscope_pricing() -> dict[str, dict[str, str]]:
    """OpenRouter-shaped ``{model: {prompt, completion, input_cache_read}}``.

    Values are per-token strings (``_format_price_per_mtok`` turns them back into
    ``$/Mtok`` for display), so the existing pricing path needs no special case.
    """
    out: dict[str, dict[str, str]] = {}
    for model_id, entry in dashscope_registry_models().items():
        cost = entry.get("cost") or {}
        prompt = _per_token(cost.get("input"))
        completion = _per_token(cost.get("output"))
        if not prompt and not completion:
            continue
        row = {"prompt": prompt, "completion": completion}
        cache_read = _per_token(cost.get("cache_read"))
        if cache_read:
            row["input_cache_read"] = cache_read
        out[model_id] = row
    return out


def _output_price(entry: dict[str, Any]) -> Optional[float]:
    try:
        value = float((entry.get("cost") or {}).get("output"))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


# The plan's standard-rate model anchors ``1×``. Anchoring on the cheapest
# legacy model instead (``qwen-turbo``) inflates every flagship into "×60+",
# which reads as a bug next to 百炼's own 倍率 table; ``qwen-plus`` is the tier
# the Token 套餐 quotes as baseline.
_BASIS_MODEL = "qwen-plus"


def dashscope_multiplier_basis() -> Optional[str]:
    """The model quoted as ``1×``: ``qwen-plus`` when priced, else the cheapest."""
    models = dashscope_registry_models()
    if (price := _output_price(models.get(_BASIS_MODEL) or {})) is not None and price > 0:
        return _BASIS_MODEL
    priced = [
        (price, model_id)
        for model_id, entry in models.items()
        if (price := _output_price(entry)) is not None
    ]
    return min(priced)[1] if priced else None


def dashscope_token_multipliers() -> dict[str, float]:
    """``{model: 倍数}`` relative to the basis model's output price (see above).
    """
    models = dashscope_registry_models()
    basis = dashscope_multiplier_basis()
    reference = _output_price(models.get(basis) or {}) if basis else None
    if not reference or reference <= 0:
        return {}
    out: dict[str, float] = {}
    for model_id, entry in models.items():
        price = _output_price(entry)
        if price is None:
            continue
        multiplier = price / reference
        out[model_id] = round(multiplier, 2) if multiplier >= 0.1 else round(multiplier, 3)
    return out


def format_multiplier(value: Any) -> str:
    """``1.0`` → ``"×1"``, ``10.82`` → ``"×10.8"``, ``0.275`` → ``"×0.28"``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return ""
    if number <= 0:
        return ""
    text = f"{number:.2f}".rstrip("0").rstrip(".")
    return f"×{text}"
