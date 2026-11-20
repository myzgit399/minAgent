"""DashScope catalog / token-倍数 table (``hermes_cli.qwen_catalog``).

The offline registry fixture keeps these tests network-free: the registry is read through
``_registry``, which is what the real code calls too.
"""

from __future__ import annotations

import pytest

from hermes_cli import qwen_catalog


@pytest.fixture()
def registry(monkeypatch):
    data = {
        "alibaba-cn": {
            "models": {
                "qwen3.8-flash": {
                    "modalities": {"output": ["text"]},
                    "tool_call": True,
                    "cost": {"input": 0.11875, "output": 0.40073, "cache_read": 0.014844},
                },
                "qwen3.8-max": {
                    "modalities": {"output": ["text"]},
                    "tool_call": True,
                    "cost": {"input": 1.77744, "output": 5.33231},
                },
                "qwen-plus": {
                    "modalities": {"output": ["text"]},
                    "cost": {"input": 0.115, "output": 0.287},
                },
                "qwen3.8-omni": {
                    "modalities": {"output": ["text"]},
                    "cost": {"input": 0.5, "output": 1.0},
                },
                # Non-chat ids must never reach the picker.
                "wan2.7-image-pro": {"modalities": {"output": ["image"]}, "cost": {"output": 9.0}},
                "qwen3-asr-flash": {"modalities": {"output": ["text"]}, "cost": {"output": 9.0}},
                "text-embedding-v4": {"modalities": {"output": ["text"]}, "cost": {"output": 9.0}},
            }
        }
    }
    monkeypatch.setattr(qwen_catalog, "_registry", lambda allow_network=False: data)
    return data


def test_chat_catalog_keeps_new_models_and_drops_non_chat(registry):
    ids = qwen_catalog.dashscope_chat_model_ids()

    assert "qwen3.8-flash" in ids
    assert "qwen3.8-max" in ids
    # Image generation, speech and embeddings are not pickable chat models.
    assert "wan2.7-image-pro" not in ids
    assert "qwen3-asr-flash" not in ids
    assert "text-embedding-v4" not in ids


def test_curated_order_leads(registry):
    ids = qwen_catalog.dashscope_chat_model_ids()

    assert ids[0] == "qwen3.8-max"
    assert ids[1] == "qwen3.8-flash"


def test_multipliers_are_relative_to_qwen_plus(registry):
    multipliers = qwen_catalog.dashscope_token_multipliers()

    assert qwen_catalog.dashscope_multiplier_basis() == "qwen-plus"
    assert multipliers["qwen-plus"] == pytest.approx(1.0)
    assert multipliers["qwen3.8-flash"] == pytest.approx(0.40073 / 0.287, rel=0.01)
    assert qwen_catalog.format_multiplier(1.0) == "×1"
    assert qwen_catalog.format_multiplier(0.275) == "×0.28"


def test_pricing_is_per_token_for_the_existing_formatter(registry):
    pricing = qwen_catalog.dashscope_pricing()

    assert pricing["qwen3.8-flash"]["prompt"].startswith("0.0000001")
    assert float(pricing["qwen3.8-flash"]["completion"]) == pytest.approx(0.40073 / 1_000_000)


def test_missing_registry_falls_back_to_empty(monkeypatch):
    monkeypatch.setattr(qwen_catalog, "_registry", lambda allow_network=False: {})

    assert qwen_catalog.dashscope_chat_model_ids() == []
    assert qwen_catalog.dashscope_token_multipliers() == {}
    assert qwen_catalog.dashscope_multiplier_basis() is None
