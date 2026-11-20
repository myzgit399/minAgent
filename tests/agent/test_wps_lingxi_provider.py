from __future__ import annotations

import json

from providers import get_provider_profile


class FakeResponse:
    status_code = 200

    def __init__(self, payload=None, lines=None):
        self._payload = payload
        self._lines = lines or []
        self.closed = False

    def json(self):
        return self._payload

    def iter_lines(self):
        return iter(self._lines)

    def close(self):
        self.closed = True


class FakeHttp:
    def __init__(self):
        self.calls = []

    def request(self, method, url, *, headers=None, **kwargs):
        assert "stream" not in kwargs, "core's http client wrapper does not accept stream=()"
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "json": kwargs.get("json"), "stream": False})
        if url.endswith("/cowork/sessions"):
            return FakeResponse({"result": "Success", "data": {"session_id": "session-1"}})
        if url.endswith("/credits/runs"):
            return FakeResponse({"result": "Success", "data": {"run_id": "run-1", "group_id": "group-1"}})
        if url.endswith("/agent-runtime/chat/completions"):
            lines = [
                "data: " + json.dumps({"code": "Success", "choices": [{"text": "你", "finish_reason": None}]}),
                "data: " + json.dumps({
                    "code": "Success",
                    "choices": [{"text": "好", "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 999},
                }),
            ]
            return FakeResponse(lines=lines)
        if method == "PUT":
            return FakeResponse({})
        raise AssertionError(f"Unexpected request: {method} {url}")


def _client(fake):
    profile = get_provider_profile("wps_lingxi")
    return profile.create_client(api_key="V02Stest-sid", http_client=fake)


def test_sdk_authorization_header_is_dropped():
    """Core's placeholder bearer must not ride along on a Cookie-authed request."""
    profile = get_provider_profile("wps_lingxi")
    client = profile.create_client(
        api_key="V02Stest-sid",
        default_headers={"Authorization": "Bearer no-key-required", "X-Test": "keep"},
    )
    headers = client._headers("https://lingxi.kdocs.cn")
    assert "Authorization" not in headers
    assert headers["X-Test"] == "keep"
    assert headers["Cookie"].startswith("wps_sid=V02Stest-sid")


def test_named_custom_route_resolves_to_plugin():
    """Desktop saves the configured provider as `custom:wps_lingxi`; that route
    must reach the private-transport plugin, not the generic OpenAI client."""
    assert get_provider_profile("custom:wps_lingxi").name == "wps_lingxi"


def test_tool_schema_composition_is_flattened():
    """灵犀 upstream rejects anyOf/oneOf/allOf with a generic AIError."""
    from plugins.model_providers.wps_lingxi.transport import rewrite_body

    body = {
        "model": "deepseek-v4.1-flash",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
        "tools": [{
            "type": "function",
            "function": {
                "name": "probe",
                "parameters": {
                    "type": "object",
                    "properties": {"x": {"anyOf": [{"type": "string"}, {"type": "integer"}]}},
                },
            },
        }],
    }
    rewritten, _ = rewrite_body(body)
    schema = rewritten["tools"][0]["function"]["parameters"]
    assert "anyOf" not in schema["properties"]["x"]
    assert schema["properties"]["x"] == {"type": "string"}


def test_wps_lingxi_three_steps_and_stream_translation():
    fake = FakeHttp()
    client = _client(fake)

    stream = client.chat.completions.create(
        model="wps-lingxi/deepseek-v4.1-flash",
        messages=[{"role": "user", "content": "你好"}],
        stream=True,
        stream_options={"include_usage": True},
        max_tokens=128,
        reasoning_effort="medium",
    )
    chunks = list(stream)
    stream.close()

    content = "".join(str(c.choices[0].delta.content or "") for c in chunks if c.choices)
    assert content == "你好"
    assert any(getattr(c.choices[0], "finish_reason", None) == "stop" for c in chunks if c.choices)
    usage = next(c.usage for c in chunks if getattr(c, "usage", None) is not None)
    assert (usage.prompt_tokens, usage.completion_tokens, usage.total_tokens) == (5, 2, 7)

    calls = fake.calls
    def call(path_suffix: str) -> dict:
        return next(c for c in calls if c["url"].endswith(path_suffix))

    session_body = call("/cowork/sessions")["json"]
    assert session_body["session_type"] == "cowork_client"
    run_body = call("/credits/runs")["json"]
    assert run_body["model_id"] == "deepseek-v4.1-flash"
    assert run_body["agent_input"]["text"] == "你好"
    chat_call = call("/agent-runtime/chat/completions")
    chat_body = chat_call["json"]
    assert chat_body["model"] == "deepseek-v4.1-flash"
    assert chat_body["stream"] is True
    assert "stream_options" not in chat_body
    assert chat_body["base_llm_arguments"] == {"max_tokens": 128}
    assert chat_body["llm_arguments"] == {"reasoning_effort": "medium"}
    assert chat_call["headers"]["x-cc-session-id"] == "session-1"
    assert chat_call["headers"]["x-cc-run-id"] == "run-1"


def test_error_frame_clears_cached_session():
    import json
    import time

    fake = FakeHttp()
    client = _client(fake)
    client._sessions[(client._uid or client._fingerprint, "deepseek-v4.1-flash")] = (time.time(), "stale")

    original = fake.request
    def request(method, url, **kwargs):
        if url.endswith("/agent-runtime/chat/completions"):
            return FakeResponse(lines=[
                "data: " + json.dumps({
                    "code": "InternalError", "message": "AI服务异常", "hint": "session expired"
                })
            ])
        return original(method, url, **kwargs)
    fake.request = request

    stream = client.chat.completions.create(
        model="deepseek-v4.1-flash", messages=[{"role": "user", "content": "hi"}], stream=True,
    )
    chunks = list(stream)
    stream.close()

    assert any("AI服务异常" in str(c.choices[0].delta.content or "") for c in chunks if c.choices)
    assert not client._sessions


def test_transport_kwargs_are_not_sent_as_json_body():
    import httpx

    fake = FakeHttp()
    client = _client(fake)
    stream = client.chat.completions.create(
        model="deepseek-v4.1-flash",
        messages=[{"role": "user", "content": "hi"}],
        stream=True,
        timeout=httpx.Timeout(10.0),
        max_retries=2,
    )
    list(stream)
    stream.close()

    body = next(c["json"] for c in fake.calls if c["url"].endswith("/agent-runtime/chat/completions"))
    assert "timeout" not in body
    assert "max_retries" not in body


def test_wps_lingxi_non_stream_assembles_response():
    fake = FakeHttp()
    client = _client(fake)
    response = client.chat.completions.create(
        model="deepseek-v4.1-flash", messages=[{"role": "user", "content": "hi"}], stream=False,
    )

    assert response.choices[0].message.content == "你好"
    assert response.choices[0].finish_reason == "stop"
    assert response.usage.total_tokens == 7
