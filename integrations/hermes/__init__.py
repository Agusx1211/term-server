"""Reports Hermes Agent lifecycle and bounded semantic history to term-server.

Installed by term-server (Settings -> Live agent activity) into
``~/.hermes/plugins/term-server-agent-events/``. Reports are private to the
term-server session that launched Hermes and never run outside that session.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from typing import Any

_PROVIDER = "hermes"
_EMIT_TIMEOUT = 2
_MAX_RECORD_BYTES = 240 * 1024


def _first(values: dict[str, Any], *keys: str) -> Any | None:
    for key in keys:
        if key in values and values[key] is not None:
            return values[key]
    return None


def _text(value: Any, depth: int = 0) -> str:
    if depth > 5 or value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "\n".join(filter(None, (_text(item, depth + 1) for item in value)))
    if isinstance(value, dict):
        for key in ("text", "content", "message", "summary", "result", "output", "error", "task"):
            found = _text(value.get(key), depth + 1)
            if found:
                return found
    return ""


def _bounded(value: Any) -> tuple[Any, bool]:
    try:
        encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
    except Exception:
        return {"truncated": True, "unserializable": True}, True
    if len(encoded) <= _MAX_RECORD_BYTES:
        return value, False
    return {"truncated": True, "originalBytes": len(encoded)}, True


def _message_record(role: str, value: Any, source: str) -> dict[str, Any] | None:
    if value is None:
        return None
    data, truncated = _bounded(value)
    text = _text(value)
    return {
        "kind": "message",
        "sourceId": source,
        "timestamp": int(time.time() * 1000),
        "role": role,
        "text": text or None,
        "data": data,
        "truncated": truncated,
    }


def _emit(event: str, details: dict[str, Any] | None = None) -> None:
    executable = os.environ.get("TERM_SERVER_EXECUTABLE")
    if (
        not executable
        or not os.environ.get("TERM_SERVER_SESSION")
        or not os.environ.get("TERM_SERVER_BROKER_SOCKET")
    ):
        return

    payload: dict[str, Any] = {
        "hook_event_name": event,
        "sequence": time.time_ns(),
    }
    if details:
        payload.update(details)
    command = [executable, "--agent-event", _PROVIDER]
    kwargs: dict[str, Any] = {
        "input": json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "timeout": _EMIT_TIMEOUT,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    try:
        subprocess.run(command, check=False, **kwargs)
    except Exception:
        # Observability must never break the agent loop.
        pass


def _on_turn_started(**kwargs: Any) -> None:
    message = _first(kwargs, "prompt", "user_message", "input", "messages")
    record = _message_record("user", message, f"user:{time.time_ns()}")
    _emit("agent_start", {"transcript": [record]} if record else None)


def _on_turn_completed(**kwargs: Any) -> None:
    message = _first(kwargs, "response", "message", "output", "result")
    record = _message_record("assistant", message, f"assistant:{time.time_ns()}")
    _emit("agent_settled", {"transcript": [record]} if record else None)


def _on_tool_started(**kwargs: Any) -> None:
    tool_name = kwargs.get("tool_name")
    args, _truncated = _bounded(_first(kwargs, "tool_input", "args", "arguments"))
    _emit(
        "tool_execution_start",
        {
            "tool_name": tool_name,
            "toolCallId": kwargs.get("tool_call_id"),
            "args": args,
        },
    )


def _on_tool_finished(**kwargs: Any) -> None:
    result, _truncated = _bounded(_first(kwargs, "tool_response", "tool_output", "result", "output"))
    _emit(
        "tool_execution_end",
        {
            "tool_name": kwargs.get("tool_name"),
            "toolCallId": kwargs.get("tool_call_id"),
            "result": result,
        },
    )


def _on_approval_requested(**_kwargs: Any) -> None:
    _emit("PermissionRequest")


def _on_approval_answered(**_kwargs: Any) -> None:
    _emit("agent_start")


def _on_session_ended(**_kwargs: Any) -> None:
    _emit("session_shutdown")


def register(ctx: Any) -> None:
    ctx.register_hook("pre_llm_call", _on_turn_started)
    ctx.register_hook("post_llm_call", _on_turn_completed)
    ctx.register_hook("pre_tool_call", _on_tool_started)
    ctx.register_hook("post_tool_call", _on_tool_finished)
    ctx.register_hook("pre_approval_request", _on_approval_requested)
    ctx.register_hook("post_approval_response", _on_approval_answered)
    ctx.register_hook("on_session_end", _on_session_ended)
