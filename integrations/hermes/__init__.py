"""Reports Hermes Agent lifecycle activity to term-server.

Installed by term-server (Settings -> Live agent activity) into
``~/.hermes/plugins/term-server-agent-events/``. It forwards Hermes lifecycle
transitions to the running term-server via ``term-server --agent-event hermes``
so the status pill shows working, blocked (waiting for input), and idle states
immediately instead of waiting for screen detection.

Observability must never interfere with the agent loop, so every emit is
fire-and-forget with a short bounded timeout and all failures are swallowed.
"""

from __future__ import annotations

import json
import os
import subprocess

_PROVIDER = "hermes"

# Bound how long an emit may block the agent loop (normally a few milliseconds).
_EMIT_TIMEOUT = 2


def _emit(event: str, tool_name: str | None = None) -> None:
    executable = os.environ.get("TERM_SERVER_EXECUTABLE")
    if (
        not executable
        or not os.environ.get("TERM_SERVER_SESSION")
        or not os.environ.get("TERM_SERVER_BROKER_SOCKET")
    ):
        # Not running inside a term-server terminal (or env not yet wired).
        return

    payload = {"hook_event_name": event}
    if tool_name:
        payload["tool_name"] = tool_name

    command = [executable, "--agent-event", _PROVIDER]
    kwargs = {
        "input": json.dumps(payload).encode("utf-8"),
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


def _on_turn_started(**_kwargs) -> None:
    _emit("agent_start")


def _on_turn_completed(**_kwargs) -> None:
    _emit("agent_settled")


def _on_tool_started(**kwargs) -> None:
    _emit("tool_execution_start", kwargs.get("tool_name"))


def _on_tool_finished(**_kwargs) -> None:
    _emit("tool_execution_end")


def _on_approval_requested(**_kwargs) -> None:
    _emit("PermissionRequest")


def _on_approval_answered(**_kwargs) -> None:
    # The turn resumes after an approval; return to working immediately so the
    # pill leaves "Needs you" the moment the user answers.
    _emit("agent_start")


def _on_session_ended(**_kwargs) -> None:
    _emit("session_shutdown")


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", _on_turn_started)
    ctx.register_hook("post_llm_call", _on_turn_completed)
    ctx.register_hook("pre_tool_call", _on_tool_started)
    ctx.register_hook("post_tool_call", _on_tool_finished)
    ctx.register_hook("pre_approval_request", _on_approval_requested)
    ctx.register_hook("post_approval_response", _on_approval_answered)
    ctx.register_hook("on_session_end", _on_session_ended)
