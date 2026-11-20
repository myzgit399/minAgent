"""Aliyun (阿里云百炼 / DashScope) provider plugin.

The bundled ``alibaba`` profile owns the international host and
``DASHSCOPE_API_KEY``; this one is the mainland compatible-mode
endpoint keyed by ``ALI_KEY``.
"""

from __future__ import annotations

import os

from agent.reasoning_effort import dashscope_preserve_thinking_extras
from providers import get_provider_profile


def test_aliyun_profile_identity_and_endpoint():
    profile = get_provider_profile("aliyun")
    assert profile is not None
    assert profile.name == "aliyun"
    assert profile.base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert profile.api_mode == "chat_completions"
    assert profile.env_vars[0] == "ALI_KEY"


def test_aliases_and_desktop_route_resolve_to_aliyun():
    for name in ("custom:aliyun", "dashscope-cn", "bailian", "aliyun-dashscope"):
        assert get_provider_profile(name).name == "aliyun", name


def test_bare_aliyun_no_longer_resolves_to_international_alibaba():
    """``aliyun`` must not fall through to the intl ``alibaba`` row — that row
    reads DASHSCOPE_API_KEY and would 401 for a user who only set ALI_KEY."""
    assert get_provider_profile("aliyun").env_vars != ("DASHSCOPE_API_KEY",)
    assert get_provider_profile("dashscope").name == "alibaba"


def test_ali_key_is_the_credential_env(monkeypatch):
    """The profile declares ALI_KEY, so credential resolution reads it."""
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.setenv("ALI_KEY", "sk-aliyun-test")
    profile = get_provider_profile("aliyun")
    assert os.environ.get(profile.env_vars[0]) == "sk-aliyun-test"


def test_preserve_thinking_extras_apply_to_qwen36():
    profile = get_provider_profile("aliyun")
    extras, top_level = profile.build_api_kwargs_extras(model="qwen3.6-plus")
    assert extras == dashscope_preserve_thinking_extras("qwen3.6-plus")
    assert top_level == {}


def test_picker_fallback_models_are_tool_calling_models():
    profile = get_provider_profile("aliyun")
    assert "qwen3.6-plus" in profile.fallback_models
    assert all(isinstance(m, str) and m for m in profile.fallback_models)
