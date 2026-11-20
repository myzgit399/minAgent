from __future__ import annotations

import agent.model_proxy as model_proxy


def test_resolve_model_proxy(monkeypatch):
    from hermes_cli import config

    monkeypatch.setattr(config, "load_config_readonly", lambda: {
        "model_proxy": {
            "url": "socks://127.0.0.1:7890",
            "models": {
                "custom:modelscope::Qwen/Qwen3.5-35B-A3B": True,
                "other::model": False,
            },
        }
    })

    assert model_proxy.resolve_model_proxy("custom:modelscope", "Qwen/Qwen3.5-35B-A3B") == (
        "socks5://127.0.0.1:7890"
    )
    assert model_proxy.resolve_model_proxy("other", "model") == ""
    assert model_proxy.resolve_model_proxy("missing", "model") is None


def test_generic_provider_matches_endpoint_family_key(monkeypatch):
    from hermes_cli import config

    monkeypatch.setattr(config, "load_config_readonly", lambda: {
        "model_proxy": {
            "url": "http://192.168.0.102:2888",
            "models": {"custom:deepseek::deepseek-flash": True},
        }
    })

    assert model_proxy.resolve_model_proxy("custom", "deepseek-flash") == (
        "http://192.168.0.102:2888"
    )


def test_no_proxy_section_keeps_env_policy(monkeypatch):
    from hermes_cli import config

    monkeypatch.setattr(config, "load_config_readonly", lambda: {})
    assert model_proxy.resolve_model_proxy("any", "model") is None


def test_agent_override_uses_requested_provider_for_custom_profile(monkeypatch):
    """A config-declared provider runs as ``custom``; its ``gemini::model`` proxy key must still apply."""
    from types import SimpleNamespace
    from hermes_cli import config

    monkeypatch.setattr(config, "load_config_readonly", lambda: {
        "model_proxy": {
            "url": "http://192.168.0.102:2888",
            "models": {"gemini::gemini-flash-latest": True},
        }
    })

    agent = SimpleNamespace(
        provider="custom", requested_provider="gemini", model="gemini-flash-latest"
    )
    assert model_proxy.agent_proxy_override(agent) == "http://192.168.0.102:2888"


def test_agent_override_prefers_live_provider_policy(monkeypatch):
    """A live-slug entry wins over the requested-provider one (explicit beats family)."""
    from types import SimpleNamespace
    from hermes_cli import config

    monkeypatch.setattr(config, "load_config_readonly", lambda: {
        "model_proxy": {
            "url": "http://192.168.0.102:2888",
            "models": {"custom::gemini-flash-latest": False, "gemini::gemini-flash-latest": True},
        }
    })

    agent = SimpleNamespace(
        provider="custom", requested_provider="gemini", model="gemini-flash-latest"
    )
    assert model_proxy.agent_proxy_override(agent) == ""
