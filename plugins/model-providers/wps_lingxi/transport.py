"""WPS 灵犀 three-step transport, exposed as an OpenAI-shaped Chat Completions client.

The private upstream flow is:

1. ``POST /api/aioffice/v1/cowork/sessions`` → ``session_id``
2. ``POST /api/public/v1/credits/runs`` → ``run_id`` / ``group_id``
3. ``POST /api/public/v1/agent-runtime/chat/completions`` →灵犀 SSE

Only this module knows about that protocol; the rest of Hermes sees ordinary
OpenAI-style chunks (``delta.content`` / ``reasoning_content`` / ``tool_calls``
/ ``finish_reason`` / ``usage``).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from types import SimpleNamespace
from typing import Any, Iterator

import httpx

BASES = ("https://lingxi.kdocs.cn", "https://lingxi.wps.cn")
SESSIONS_PATH = "/api/aioffice/v1/cowork/sessions"
RUNS_PATH = "/api/public/v1/credits/runs"
CHAT_PATH = "/api/public/v1/agent-runtime/chat/completions"
STATUS_PATH = "/api/public/v1/sessions/{session_id}/execution_status"
DEFAULT_MODEL = "deepseek-v4.1-flash"
MODELS_PATH = "/api/aioffice/v1/sessions/models"
MODELS_CACHE_PATH = "/api/aioffice/v1/sessions/plans"  # same models + multiplier metadata
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Lingxi Claw/1.3.36 Chrome/144.0.7559.236 "
      "Electron/40.8.2 Safari/537.36")
SESSION_TTL_SECONDS = 600
logger = logging.getLogger(__name__)
_STATUS_PREFIXES = ("wps-lingxi/", "lingxi/", "lingxi-")
# OpenAI SDK / Hermes request controls that must never become JSON body fields.
TRANSPORT_KWARGS = {
    "timeout", "max_retries", "extra_headers", "extra_query", "extra_body",
    "http_client", "api_key", "base_url", "api_base", "client", "_strict",
}


class WpsLingxiError(RuntimeError):
    def __init__(self, message: str, *, code: str = "", status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _ns(**kwargs: Any) -> SimpleNamespace:
    return SimpleNamespace(**kwargs)


def normalize_model(model: Any) -> str:
    name = str(model or "").strip()
    for prefix in _STATUS_PREFIXES:
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    return name or DEFAULT_MODEL


def _cookie_parts(raw: str) -> tuple[str, str, str]:
    """Return ``(cookie_header, uid, sid_fingerprint)`` without leaking the sid."""
    text = raw.strip()
    if "wps_sid=" not in text:
        text = f"wps_sid={text}"
    match = re.search(r"(?:^|;\s*)uid=([^;]+)", text)
    uid = match.group(1).strip() if match else ""
    sid_match = re.search(r"(?:^|;\s*)wps_sid=([^;]+)", text)
    fingerprint = hashlib.sha256((sid_match.group(1) if sid_match else text).encode()).hexdigest()[:16]
    extras = [
        "x-kso-app-name=win-lingxi-desktop",
        "x-kso-app-version=1.3.36",
        f"x-kso-device-id={hashlib.sha256(('lingxi2api:' + (uid or fingerprint)).encode()).hexdigest()[:16]}",
    ]
    if uid and "uid=" not in text:
        extras.append(f"uid={uid}")
    return "; ".join([text, *extras]), uid, fingerprint


def fetch_model_catalog(*, api_key=None, base_url=None, timeout=8.0):
    """Return the live model IDs from WPS 灵犀's ``sessions/models`` endpoint.

    Mirrors the cookie/UA shape the chat transport uses (WPS rejects a Bearer
    token here). ``api_key`` is the ``wps_sid`` value from config. Returns
    ``None`` on any failure so callers fall back to ``FALLBACK_MODELS``.
    Never logs the credential.
    """
    raw = str(api_key or os.environ.get("WPS_LINGXI_SID")
              or os.environ.get("WPS_LINGXI_COOKIE") or "").strip()
    if not raw:
        return None
    cookie, _, _ = _cookie_parts(raw)
    base = str(base_url or BASES[0]).rstrip("/")
    headers = {
        "Cookie": cookie,
        "User-Agent": UA,
        "Accept": "application/json",
        "X-Client-Type": "lingxi_claw",
        "Referer": base + "/",
    }
    for candidate in [base] + [b for b in BASES if b != base]:
        try:
            resp = httpx.get(candidate + MODELS_PATH, headers=headers, timeout=float(timeout or 8))
            if resp.status_code != 200:
                continue
            data = resp.json()
            models = (data.get("data") or {}).get("models") if isinstance(data, dict) else None
            ids = [m.get("key") for m in models
                   if isinstance(m, dict) and isinstance(m.get("key"), str) and m["key"]]
            if ids:
                return list(dict.fromkeys(ids))
        except Exception:
            continue
    return None


def last_user_text(messages: Any) -> str:
    if not isinstance(messages, list):
        return "hi"
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = " ".join(
                str(part.get("text", "")) for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        else:
            text = ""
        text = text.strip()
        if text:
            return text[:40]
    return "hi"


def _flatten_json_schema(node: Any) -> Any:
    """灵犀 rejects tool schemas that use anyOf/oneOf/allOf.

    JSON Schema composition keys (``anyOf``/``oneOf``/``allOf``) are not accepted
    by the upstream model backend; they surface as a generic AIError. Prefer the
    object branch when flattening, otherwise the first typed branch.
    """
    if isinstance(node, list):
        return [_flatten_json_schema(item) for item in node]
    if not isinstance(node, dict):
        return node
    for key in ("anyOf", "oneOf", "allOf"):
        branches = node.get(key)
        if isinstance(branches, list) and branches:
            chosen = next((b for b in branches
                           if isinstance(b, dict) and str(b.get("type")) == "object"), None)
            if chosen is None:
                chosen = next((b for b in branches
                               if isinstance(b, dict) and "type" in b), None)
            if chosen is None:
                chosen = branches[0] if isinstance(branches[0], dict) else {}
            merged = {k: v for k, v in chosen.items() if k != key}
            return _flatten_json_schema(merged)
    return {k: _flatten_json_schema(v) for k, v in node.items()}


def rewrite_body(body: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Convert a Chat Completions request into 灵犀's third-step body."""
    rewritten = {k: v for k, v in dict(body).items() if k not in TRANSPORT_KWARGS}
    model = normalize_model(rewritten.pop("model", None))
    rewritten.pop("stream_options", None)
    rewritten["model"] = model
    rewritten["stream"] = True

    max_tokens = rewritten.pop("max_tokens", None)
    reasoning_effort = rewritten.pop("reasoning_effort", None)
    if max_tokens is not None:
        rewritten["base_llm_arguments"] = {"max_tokens": max_tokens}
    if isinstance(reasoning_effort, str) and reasoning_effort:
        rewritten["llm_arguments"] = {"reasoning_effort": reasoning_effort}

    tools = rewritten.get("tools")
    if isinstance(tools, list):
        rewritten["tools"] = [
            {**tool, "function": {**fn, "parameters": _flatten_json_schema(fn.get("parameters"))}}
            if isinstance(tool, dict) and isinstance(fn := tool.get("function"), dict)
            else tool
            for tool in tools
        ]
    return rewritten, model


class WpsLingxiClient:
    """OpenAI-shaped facade. Declares the transport-wrap skip used by native shims."""

    HERMES_SKIP_TRANSPORT_WRAP = True

    def __init__(self, *, api_key: Any = None, base_url: Any = None, timeout: Any = None,
                 http_client: Any = None, default_headers: Any = None):
        raw = str(api_key or os.environ.get("WPS_LINGXI_SID")
                  or os.environ.get("WPS_LINGXI_COOKIE") or "").strip()
        self._cookie, self._uid, self._fingerprint = _cookie_parts(raw) if raw else ("", "", "")
        self._base_url = str(base_url or BASES[0]).rstrip("/")
        # Core passes OpenAI SDK default headers, which can include a placeholder
        # `Authorization: Bearer no-key-required`. 灵犀 authenticates by Cookie
        # only; an SDK Authorization header makes the upstream return 401.
        self._extra_default_headers = {
            k: v for k, v in dict(default_headers or {}).items()
            if str(k).lower() not in {"authorization", "cookie", "content-type", "host", "accept"}
        }
        self._http = http_client or httpx.Client(timeout=float(timeout or 120))
        self._owns_http = http_client is None
        self._sessions: dict[tuple[str, str], tuple[float, str]] = {}
        self._session_lock = threading.Lock()
        self.chat = _ns(completions=_Completions(self))

    def close(self) -> None:
        if self._owns_http:
            try:
                self._http.close()
            except Exception:
                pass

    def _headers(self, base: str, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "Cookie": self._cookie,
            "Content-Type": "application/json",
            "X-Client-Type": "lingxi_claw",
            "X-Client-Lang": "zh-CN",
            "X-Cc-Agent-Type": "lingxi_claw",
            "X-Request-Id": str(uuid.uuid4()),
            "Referer": base + "/",
            "User-Agent": UA,
        }
        headers.update(self._extra_default_headers)
        if extra:
            headers.update(extra)
        return headers

    def _post(self, path: str, payload: dict[str, Any], *, extra: dict[str, str] | None = None,
              stream: bool = False) -> Any:
        if not self._cookie:
            raise WpsLingxiError(
                "WPS 灵犀未配置凭据：请设置环境变量 WPS_LINGXI_SID（V02S 开头的 Cookie 值）。"
            )
        last_error: Exception | None = None
        bases = [self._base_url] + [b for b in BASES if b != self._base_url]
        for base in bases:
            try:
                # Core may hand us an OpenAI SDK client wrapper whose request()
                # has no `stream` kwarg. Read the SSE fully and split it later.
                response = self._http.request(
                    "POST", base + path, headers=self._headers(base, extra),
                    json=payload,
                )
                if response.status_code >= 400:
                    raise WpsLingxiError(
                        f"WPS 灵犀请求失败 (HTTP {response.status_code})",
                        status_code=response.status_code,
                    )
                return response
            except WpsLingxiError:
                raise
            except Exception as exc:
                last_error = exc
        raise WpsLingxiError(f"WPS 灵犀请求失败: {last_error}") from last_error

    @staticmethod
    def _envelope(response: Any) -> dict[str, Any]:
        payload = response.json()
        if not isinstance(payload, dict):
            raise WpsLingxiError("WPS 灵犀返回了无法解析的响应")
        code = str(payload.get("result") or payload.get("code") or "")
        if code and code.lower() not in {"success", "ok", "0"}:
            raise WpsLingxiError(f"WPS 灵犀错误: {payload.get('hint') or payload.get('msg') or code}", code=code)
        data = payload.get("data")
        return data if isinstance(data, dict) else payload

    def _clear_session(self, model: str) -> None:
        with self._session_lock:
            self._sessions.pop((self._uid or self._fingerprint, model), None)

    def _session_id(self, model: str) -> str:
        key = (self._uid or self._fingerprint, model)
        with self._session_lock:
            cached = self._sessions.get(key)
            if cached and time.time() - cached[0] < SESSION_TTL_SECONDS:
                return cached[1]
        response = self._post(SESSIONS_PATH, {
            "session_type": "cowork_client",
            "agent_version": 2,
            "env": {
                "device_id": self._fingerprint,
                "device_name": "lingxi2api",
                "work_space_dir": "/tmp",
            },
        })
        session_id = str(self._envelope(response).get("session_id") or "").strip()
        if not session_id:
            raise WpsLingxiError("WPS 灵犀未返回 session_id")
        with self._session_lock:
            self._sessions[key] = (time.time(), session_id)
        return session_id

    def _run(self, model: str, session_id: str, text: str) -> tuple[str, str, str]:
        response = self._post(RUNS_PATH, {
            "client_request_id": str(int(time.time() * 1000)),
            "session_id": session_id,
            "model_provider": "lingxi",
            "model_id": model,
            "agent_input": {
                "text": text,
                "files": [],
                "file_ids": [],
                "expect_model": model,
                "refs": [],
                "permission_mode": "default",
                "current_mode": "agent",
                "browser_plugin_enabled": False,
            },
        })
        data = self._envelope(response)
        run_id = str(data.get("run_id") or "").strip()
        if not run_id:
            raise WpsLingxiError("WPS 灵犀未返回 run_id")
        group_id = str(data.get("group_id") or run_id)
        return run_id, group_id, self._base_url

    def _report_status(self, base: str, session_id: str, group_id: str, status: str,
                       terminal_reason: str = "") -> None:
        payload: dict[str, Any] = {"group_id": group_id, "status": status, "run_token": group_id}
        if status == "running":
            payload["lease_seconds"] = 90
        if terminal_reason:
            payload["terminal_reason"] = terminal_reason
        try:
            self._http.request("PUT", base + STATUS_PATH.format(session_id=session_id),
                               headers=self._headers(base), json=payload)
        except Exception:
            pass

    def _chat_response(self, body: dict[str, Any]) -> tuple[Any, str, str, str, str]:
        rewritten, model = rewrite_body(body)
        tools = rewritten.get("tools") or []
        tool_summary = []
        for tool in tools:
            fn = tool.get("function") if isinstance(tool, dict) else None
            schema = (fn or {}).get("parameters") if isinstance(fn, dict) else None
            schema_str = json.dumps(schema, ensure_ascii=False, sort_keys=True) if schema is not None else ""
            features = sorted({f for f in (
                "$ref", "anyOf", "oneOf", "allOf", "patternProperties",
                "format", "pattern", "additionalProperties", "propertyNames",
                "minItems", "maxItems", "minLength", "maxLength", "exclusiveMinimum",
            ) if f in schema_str})
            tool_summary.append({
                "name": (fn or {}).get("name") if isinstance(fn, dict) else None,
                "schema_bytes": len(schema_str),
                "features": features,
            })
        logger.debug(
            "WPS 灵犀 request shape: keys=%s messages=%s tools=%s stream=%s model=%s tools_summary=%s",
            sorted(rewritten.keys()),
            len(rewritten.get("messages") or []),
            len(tools),
            bool(rewritten.get("stream")),
            model,
            tool_summary,
        )
        session_id = self._session_id(model)
        run_id, group_id, base = self._run(model, session_id, last_user_text(body.get("messages")))
        self._report_status(base, session_id, group_id, "running")
        response = self._post(CHAT_PATH, rewritten, extra={
            "x-cc-session-id": session_id,
            "x-cc-run-id": run_id,
            "Accept": "text/event-stream",
        }, stream=True)
        return response, model, session_id, group_id, base


class _Completions:
    def __init__(self, client: WpsLingxiClient):
        self._client = client

    def create(self, **kwargs: Any) -> Any:
        response, model, session_id, group_id, base = self._client._chat_response(kwargs)
        stream = _LingxiStream(self._client, response, model, session_id, group_id, base)
        if kwargs.get("stream"):
            return stream
        try:
            chunks = list(stream)
        finally:
            stream.close()
        return _assemble_response(model, chunks)


class _LingxiStream:
    def __init__(self, client: WpsLingxiClient, response: Any, model: str,
                 session_id: str, group_id: str, base: str):
        self._client = client
        self._response = response
        self._model = model
        self._session_id = session_id
        self._group_id = group_id
        self._base = base
        self._closed = False

    def __iter__(self) -> Iterator[Any]:
        yield from self._frames()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._response.close()
        except Exception:
            pass
        self._client._report_status(self._base, self._session_id, self._group_id, "completed")

    def _frames(self) -> Iterator[Any]:
        usage_seen = False
        finish_seen = False
        try:
            lines = (self._response.iter_lines() if hasattr(self._response, "iter_lines")
                     else str(getattr(self._response, "text", "") or "").splitlines())
            for raw_line in lines:
                line = raw_line.strip()
                if not line or line.startswith(":") or line.startswith("event:"):
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    frame = json.loads(data)
                except ValueError:
                    continue
                if not isinstance(frame, dict):
                    continue

                code = str(frame.get("code") or "")
                message = str(frame.get("message") or "")
                if code and code.lower() != "success":
                    # A stale cached session can surface as a generic upstream
                    # error. Log only metadata (never message text or cookie)
                    # and drop the session so the next request starts clean.
                    logger.warning(
                        "WPS 灵犀 upstream error frame: code=%s message=%s hint=%s model=%s",
                        code, message, str(frame.get("hint") or "")[:200], self._model,
                    )
                    self._client._clear_session(self._model)
                    yield _content_chunk(self._model, f"\n[上游错误] {message}")
                    yield _finish_chunk(self._model, "stop")
                    finish_seen = True
                    break

                choice = _first_choice(frame)
                if choice is not None:
                    text = choice.get("text")
                    if text:
                        yield _content_chunk(self._model, str(text))
                    reasoning = choice.get("reasoning_content")
                    if reasoning:
                        yield _delta_chunk(self._model, {"reasoning_content": str(reasoning)})
                    tool_calls = choice.get("tool_calls")
                    if isinstance(tool_calls, list) and tool_calls:
                        yield _delta_chunk(self._model, {"tool_calls": [
                            _tool_call_delta(item) for item in tool_calls if isinstance(item, dict)
                        ]})
                    finish = choice.get("finish_reason")
                    if finish:
                        yield _finish_chunk(self._model, str(finish))
                        finish_seen = True

                parsed_usage = _usage(frame.get("usage"))
                if parsed_usage is not None:
                    usage_seen = True
                    yield _usage_chunk(self._model, parsed_usage)
        except Exception as exc:
            yield _content_chunk(self._model, f"\n[上游错误] {exc}")
            yield _finish_chunk(self._model, "stop")
            finish_seen = True
        finally:
            if not finish_seen:
                yield _finish_chunk(self._model, "stop")
            if not usage_seen:
                yield _usage_chunk(self._model, _ns(prompt_tokens=0, completion_tokens=0, total_tokens=0,
                                                    cached_tokens=0))


def _first_choice(frame: dict[str, Any]) -> dict[str, Any] | None:
    choices = frame.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        return choices[0]
    return None


def _tool_call_delta(item: dict[str, Any]) -> Any:
    function = item.get("function") if isinstance(item.get("function"), dict) else {}
    return _ns(
        index=item.get("index") or 0,
        id=item.get("id") or "",
        type=item.get("type") or "function",
        function=_ns(name=function.get("name") or "", arguments=function.get("arguments") or ""),
    )


def _usage(value: Any) -> Any | None:
    if not isinstance(value, dict):
        return None
    prompt = int(value.get("prompt_tokens") or 0)
    completion = int(value.get("completion_tokens") or 0)
    cached = int(value.get("cached_tokens") or 0)
    return _ns(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
        cached_tokens=cached,
        prompt_tokens_details=_ns(cached_tokens=cached),
    )


def _chunk(model: str, delta: Any | None, finish_reason: Any = None, usage: Any | None = None) -> Any:
    choices = []
    if delta is not None or finish_reason is not None:
        choices.append(_ns(index=0, delta=delta or _ns(), finish_reason=finish_reason,
                           logprobs=None, text_match=None))
    return _ns(
        id=f"chatcmpl-lingxi-{uuid.uuid4().hex}",
        object="chat.completion.chunk",
        created=int(time.time()),
        model=model,
        choices=choices,
        usage=usage,
        service_tier=None,
        system_fingerprint=None,
    )


def _delta_chunk(model: str, fields: dict[str, Any]) -> Any:
    delta = _ns(role="assistant", content=None, reasoning_content=None, reasoning=None,
                refusal=None, tool_calls=None, function_call=None, model_extra={})
    for key, value in fields.items():
        setattr(delta, key, value)
    return _chunk(model, delta)


def _content_chunk(model: str, text: str) -> Any:
    return _delta_chunk(model, {"content": text})


def _finish_chunk(model: str, reason: str) -> Any:
    return _chunk(model, _ns(role="assistant", content=None, reasoning_content=None, reasoning=None,
                             refusal=None, tool_calls=None, function_call=None, model_extra={}), reason)


def _usage_chunk(model: str, usage: Any) -> Any:
    return _chunk(model, None, None, usage)


def _assemble_response(model: str, chunks: list[Any]) -> Any:
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: list[Any] = []
    finish_reason = "stop"
    usage = None
    for chunk in chunks:
        if getattr(chunk, "usage", None) is not None:
            usage = chunk.usage
        for choice in getattr(chunk, "choices", None) or []:
            if getattr(choice, "finish_reason", None):
                finish_reason = choice.finish_reason
            delta = getattr(choice, "delta", None)
            if delta is None:
                continue
            if getattr(delta, "content", None):
                content_parts.append(str(delta.content))
            if getattr(delta, "reasoning_content", None):
                reasoning_parts.append(str(delta.reasoning_content))
            for call in getattr(delta, "tool_calls", None) or []:
                tool_calls.append(call)
    message = _ns(role="assistant", content="".join(content_parts) or None,
                  reasoning_content="".join(reasoning_parts) or None, tool_calls=tool_calls or None,
                  refusal=None, function_call=None, model_extra={})
    return _ns(
        id=f"chatcmpl-lingxi-{uuid.uuid4().hex}",
        object="chat.completion",
        created=int(time.time()),
        model=model,
        choices=[_ns(index=0, message=message, finish_reason=finish_reason, logprobs=None, text_match=None)],
        usage=usage or _ns(prompt_tokens=0, completion_tokens=0, total_tokens=0, cached_tokens=0,
                           prompt_tokens_details=_ns(cached_tokens=0)),
        service_tier=None,
        system_fingerprint=None,
    )
