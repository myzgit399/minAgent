"""WPS 灵犀 provider plugin.

WPS 灵犀's desktop backend speaks a private three-step protocol
(``sessions → credits/runs → agent-runtime/chat/completions``) and returns its
own SSE frame shape. This profile supplies an OpenAI-shaped client so the rest
of Hermes can keep using its normal Chat Completions request builder/stream
consumer.

Credentials are read from ``WPS_LINGXI_SID`` (bare ``V02S...`` sid or a full
Cookie header) or ``WPS_LINGXI_COOKIE``. Never log them.
"""
from __future__ import annotations

from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

FALLBACK_MODELS = (
    "auto",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro-0813",
    "qwen3.8_flash",
    "qwen4_max",
    "mimo-v2.6-pro",
    "GLM-5.3-Flash",
    "GLM-5.3",
    "minimax_m3",
    "doubao_seed_2_1_pro_260628",
    "kimi-k3",
    "kimi-k3.1-pro",
)
MODEL_ALIASES = {
    "auto": "auto",
    "flash": "deepseek-v4.1-flash",
    "pro": "deepseek-v4-pro-0813",
    "qwen": "qwen3.8_flash",
    "glm": "GLM-5.3-Flash",
    "kimi": "kimi-k3",
}


class WpsLingxiProfile(ProviderProfile):
    def create_client(self, **client_kwargs: Any) -> Any:
        from .transport import WpsLingxiClient

        allowed = {"api_key", "base_url", "timeout", "http_client", "default_headers"}
        return WpsLingxiClient(**{k: v for k, v in client_kwargs.items() if k in allowed})

    def get_max_tokens(self, model: str | None) -> int | None:
        return None

    def fetch_models(self, *, api_key=None, base_url=None, timeout=8.0):
        """Fetch the live WPS 灵犀 model list from its sessions/models endpoint.

        WPS Lingxi's catalog is a private GET (cookie ``wps_sid`` auth), not an
        OpenAI ``/v1/models`` endpoint, so the base implementation cannot reach
        it. Reading this endpoint is what makes newly published models (e.g.
        ``qwen4_max``, ``minimax_m3``, ``kimi-k3.1-pro``) appear without a code
        change. On any failure we return ``None`` and callers fall back to
        ``FALLBACK_MODELS`` above.
        """
        try:
            from .transport import MODELS_PATH, fetch_model_catalog

            return fetch_model_catalog(api_key=api_key, base_url=base_url, timeout=timeout)
        except Exception:  # pragma: no cover - discovery must never break a picker
            return None


register_provider(WpsLingxiProfile(
    name="wps_lingxi",
    aliases=("wps-lingxi", "lingxi", "wpslingxi", "custom:wps_lingxi", "custom:wps-lingxi"),
    display_name="WPS 灵犀",
    description="WPS 灵犀桌面端模型通道（wps_sid 鉴权）",
    env_vars=("WPS_LINGXI_SID", "WPS_LINGXI_COOKIE"),
    base_url="https://lingxi.kdocs.cn",
    auth_type="api_key",
    api_mode="chat_completions",
    supports_health_check=False,
    supports_model_listing=True,
    supports_vision=False,
    fallback_models=FALLBACK_MODELS,
    model_aliases=MODEL_ALIASES,
    default_aux_model="deepseek-v4.1-flash",
))
