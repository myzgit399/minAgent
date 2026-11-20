"""Aliyun (阿里云百炼 / DashScope) provider profile.

Alibaba Cloud Model Studio's OpenAI-compatible endpoint, mainland-China
(`dashscope.aliyuncs.com`). The bundled ``alibaba`` profile points at the
international host and reads ``DASHSCOPE_API_KEY``; this profile is the
domestic endpoint for users whose key lives in ``ALI_KEY``.

The wire is plain Chat Completions, so only the DashScope-specific
quirk is carried over: replayed prior-turn reasoning must be kept for
Qwen 3.6+ / hosted Kimi K2.6+ (see ``dashscope_preserve_thinking_extras``).
"""

from __future__ import annotations

from typing import Any

from agent.reasoning_effort import dashscope_preserve_thinking_extras
from providers import register_provider
from providers.base import ProviderProfile

# Curated picker list (mainland compatible-mode ids). Kept in one place with the
# ``alibaba``/DashScope catalog so new ids (e.g. ``qwen3.8-flash``) cannot appear
# on one surface and go missing on another; live ``/models`` discovery still leads
# when it works. Extra ids are appended after the release-time floor.
_FLOOR_MODELS = (
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.8-omni-flash",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.7-flash",
    "qwen3.6-plus",
    "qwen3.6-flash",
    "qwen3-coder-flash",
    "qwen3-coder-plus",
    "qwen3.5-plus",
    "qwen3-vl-plus",
    "qwen-max",
    "qwen-plus",
    "qwen-flash",
    "deepseek-v4-pro",
    "kimi-k2.5",
    "glm-5.2",
    "MiniMax-M2.5",
)


def _fallback_models() -> tuple[str, ...]:
    try:
        from hermes_cli.qwen_catalog import dashscope_chat_model_ids

        catalog = dashscope_chat_model_ids()
    except Exception:
        catalog = []
    if not catalog:
        return _FLOOR_MODELS
    return tuple(dict.fromkeys([*_FLOOR_MODELS, *catalog]))


FALLBACK_MODELS = _fallback_models()


class AliyunProfile(ProviderProfile):
    """DashScope compatible-mode: keep replayed reasoning on Qwen/Kimi."""

    def build_api_kwargs_extras(
        self, *, model: str | None = None, **context: Any
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        return dashscope_preserve_thinking_extras(model), {}


aliyun = AliyunProfile(
    name="aliyun",
    aliases=("aliyun-dashscope", "dashscope-cn", "bailian", "ali-bailian", "custom:aliyun"),
    display_name="Aliyun DashScope (阿里云百炼)",
    description="阿里云百炼 DashScope 兼容模式（Qwen 及多厂商模型）",
    signup_url="https://bailian.console.aliyun.com/",
    env_vars=("ALI_KEY",),
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    api_mode="chat_completions",
    auth_type="api_key",
    fallback_models=FALLBACK_MODELS,
    # No aux default: this key 403s `AccessDenied.Unpurchased` on the models it does not own
    # (qwen3.6-flash among them), and compaction/title calls routed there just failed. Aux
    # inherits the session's own model instead.
    default_aux_model=None,
)

register_provider(aliyun)
