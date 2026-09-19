"""
antigravity_acp/server.py
─────────────────────────
ACP (Agent Client Protocol) stdio JSON-RPC server that wraps the Antigravity
(agy) CLI.  Praxis spawns this process and drives it over the ACP protocol;
this server translates those requests into `agy --output-format stream-json`
subprocess calls and converts `agy`'s NDJSON event stream back into ACP
`session/update` notifications + a `session/prompt` response.

Protocol implemented (the minimum Praxis actually uses):
  Agent-side methods (we handle as JSON-RPC server):
    initialize          → advertise capabilities, return version info
    session/new         → create session, return sessionId + empty config
    session/prompt      → run one agy turn; stream agent_message_chunk
                          notifications, resolve when result arrives
    session/cancel      → best-effort: kill the in-flight agy subprocess

  Client-side methods (we call as JSON-RPC client on Praxis):
    session/update      → notification carrying SessionUpdate objects

Transport: newline-delimited JSON (NDJSON) over stdin/stdout, exactly as the
@agentclientprotocol/sdk's `ndJsonStream` adapter expects.

agy stream-json output event shapes (observed):
  {"event":"init", "conversation_id": "...", "init": {...}}
  {"event":"step_update", "step_update": {
      "conversation_id": "...", "step_index": N, "state": "ACTIVE"|"DONE",
      "step_type": "agent_response"|"tool_call"|"user_input"|...,
      "text_delta": "..."   # present on agent_response steps
  }}
  {"event":"result", "result": {
      "conversation_id": "...", "status": "SUCCESS"|"ERROR",
      "response": "...", "error": "...", "usage": {...}
  }}

ACP session/update notification body shape (agent_message_chunk):
  {"sessionId": "...", "update": {"sessionUpdate": "agent_message_chunk",
                                  "delta": {"type": "text", "text": "..."}}}
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import uuid
from typing import Any

logging.basicConfig(
    stream=sys.stderr,
    level=logging.WARNING,
    format="[antigravity-acp] %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Protocol constants ────────────────────────────────────────────────────────

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "antigravity-acp"
SERVER_VERSION = "0.1.0"

AGENT_METHODS = {
    "initialize": "initialize",
    "session_new": "session/new",
    "session_prompt": "session/prompt",
    "session_cancel": "session/cancel",
    "session_close": "session/close",
}

CLIENT_METHODS = {
    "session_update": "session/update",
}


# ── I/O helpers ───────────────────────────────────────────────────────────────

_write_lock = threading.Lock()


def send(obj: dict) -> None:
    """Write one NDJSON line to stdout (thread-safe)."""
    line = json.dumps(obj, separators=(",", ":")) + "\n"
    with _write_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def send_notification(method: str, params: dict) -> None:
    send({"jsonrpc": "2.0", "method": method, "params": params})


def send_response(req_id: Any, result: Any) -> None:
    send({"jsonrpc": "2.0", "id": req_id, "result": result})


def send_error(req_id: Any, code: int, message: str, data: Any = None) -> None:
    err: dict = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    send({"jsonrpc": "2.0", "id": req_id, "error": err})


# ── Session state ─────────────────────────────────────────────────────────────


class Session:
    def __init__(self, session_id: str, cwd: str) -> None:
        self.session_id = session_id
        self.cwd = cwd
        # conversation_id issued by agy for the first turn; passed as
        # --conversation on subsequent turns for session continuity.
        self.conversation_id: str | None = None
        self._cancel_proc: subprocess.Popen | None = None
        self._cancel_lock = threading.Lock()

    def cancel(self) -> None:
        with self._cancel_lock:
            proc = self._cancel_proc
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    def _run_turn(self, prompt_text: str, req_id: Any) -> None:
        """Run one agy turn in a background thread, emitting ACP notifications."""
        agy_bin = shutil.which("agy")
        if not agy_bin:
            send_error(req_id, -32603, "agy not found on PATH")
            return

        cmd = [agy_bin, "--output-format", "stream-json", "--dangerously-skip-permissions"]
        if self.conversation_id:
            cmd += ["--conversation", self.conversation_id]
        cmd += ["--print", prompt_text]

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=self.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            send_error(req_id, -32603, f"Failed to start agy: {exc}")
            return

        with self._cancel_lock:
            self._cancel_proc = proc

        stop_reason = "end_turn"
        full_response = ""
        error_message: str | None = None
        usage: dict = {}

        try:
            for raw_line in proc.stdout:  # type: ignore[union-attr]
                raw_line = raw_line.rstrip("\n")
                if not raw_line:
                    continue
                try:
                    evt = json.loads(raw_line)
                except json.JSONDecodeError:
                    log.debug("agy non-JSON line: %s", raw_line[:200])
                    continue

                event_type = evt.get("event")

                if event_type == "init":
                    # Capture the conversation_id on the very first turn.
                    if not self.conversation_id:
                        self.conversation_id = evt.get("conversation_id")

                elif event_type == "step_update":
                    su = evt.get("step_update", {})
                    step_type = su.get("step_type")
                    text_delta = su.get("text_delta")
                    if step_type == "agent_response" and text_delta:
                        send_notification(
                            CLIENT_METHODS["session_update"],
                            {
                                "sessionId": self.session_id,
                                "update": {
                                    "sessionUpdate": "agent_message_chunk",
                                    "delta": {"type": "text", "text": text_delta},
                                },
                            },
                        )

                elif event_type == "result":
                    res = evt.get("result", {})
                    status = res.get("status", "ERROR")
                    full_response = res.get("response", "")
                    error_message = res.get("error")
                    usage = res.get("usage", {})
                    if status != "SUCCESS":
                        stop_reason = "error"
                    # Use result conversation_id to ensure we have it.
                    if not self.conversation_id:
                        self.conversation_id = res.get("conversation_id")

        finally:
            proc.wait()
            with self._cancel_lock:
                self._cancel_proc = None

        # Build the session/prompt response.
        if stop_reason == "error" and error_message:
            # Surface the error as an ACP error so Praxis's limit detection fires.
            send_error(
                req_id,
                -32603,
                error_message,
                {"errorKind": "provider_error"},
            )
            return

        # Emit a usage_update notification so Praxis can track token costs.
        if usage:
            input_tok = usage.get("input_tokens", 0)
            output_tok = usage.get("output_tokens", 0)
            send_notification(
                CLIENT_METHODS["session_update"],
                {
                    "sessionId": self.session_id,
                    "update": {
                        "sessionUpdate": "usage_update",
                        "inputTokens": input_tok,
                        "outputTokens": output_tok,
                        "totalTokens": input_tok + output_tok,
                    },
                },
            )

        send_response(
            req_id,
            {
                "stopReason": stop_reason,
                "output": [{"type": "text", "text": full_response}],
            },
        )


# ── Request dispatcher ────────────────────────────────────────────────────────

_sessions: dict[str, Session] = {}
_active_session: Session | None = None


def handle_initialize(req_id: Any, params: dict) -> None:
    send_response(
        req_id,
        {
            "protocolVersion": PROTOCOL_VERSION,
            "agentInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "agentCapabilities": {
                "sessionCapabilities": {
                    "close": True,
                },
            },
        },
    )


def handle_session_new(req_id: Any, params: dict) -> None:
    global _active_session
    cwd = params.get("cwd", os.getcwd())
    session_id = str(uuid.uuid4())
    session = Session(session_id, cwd)
    _sessions[session_id] = session
    _active_session = session
    send_response(req_id, {"sessionId": session_id, "configOptions": []})


def handle_session_prompt(req_id: Any, params: dict) -> None:
    session_id = params.get("sessionId", "")
    session = _sessions.get(session_id)
    if session is None:
        send_error(req_id, -32602, f"Unknown session: {session_id}")
        return

    # Extract text from the ACP prompt array.
    prompt_parts = params.get("prompt", [])
    text_parts = [
        p.get("text", "") for p in prompt_parts if isinstance(p, dict) and p.get("type") == "text"
    ]
    prompt_text = "".join(text_parts).strip()
    if not prompt_text:
        send_error(req_id, -32602, "Empty prompt")
        return

    # Run asynchronously so we can handle cancel notifications while in-flight.
    t = threading.Thread(target=session._run_turn, args=(prompt_text, req_id), daemon=True)
    t.start()
    # The thread sends send_response/send_error when done; we don't block here.


def handle_session_cancel(req_id: Any, params: dict) -> None:
    session_id = params.get("sessionId", "")
    session = _sessions.get(session_id)
    if session:
        session.cancel()
    # Cancel is a notification in the spec; if it has an id, acknowledge it.
    if req_id is not None:
        send_response(req_id, {})


def handle_session_close(req_id: Any, params: dict) -> None:
    session_id = params.get("sessionId", "")
    _sessions.pop(session_id, None)
    if req_id is not None:
        send_response(req_id, {})


_HANDLERS = {
    AGENT_METHODS["initialize"]: handle_initialize,
    AGENT_METHODS["session_new"]: handle_session_new,
    AGENT_METHODS["session_prompt"]: handle_session_prompt,
    AGENT_METHODS["session_cancel"]: handle_session_cancel,
    AGENT_METHODS["session_close"]: handle_session_close,
}


# ── Main loop ─────────────────────────────────────────────────────────────────


def run() -> int:
    """Entry point: read NDJSON from stdin, dispatch, write NDJSON to stdout."""
    # Use binary-mode read for robustness, decode manually.
    stdin_bin = sys.stdin.buffer if hasattr(sys.stdin, "buffer") else sys.stdin
    # Reconfigure stdout to be unbuffered text.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]

    for raw in stdin_bin:
        line = raw.decode("utf-8", errors="replace").rstrip("\n")
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            log.warning("Malformed JSON from client: %s (%s)", line[:120], exc)
            continue

        method = msg.get("method")
        req_id = msg.get("id")  # None for notifications
        params = msg.get("params") or {}

        if method is None:
            # Response to one of our requests (we don't make any yet).
            continue

        handler = _HANDLERS.get(method)
        if handler is None:
            if req_id is not None:
                send_error(req_id, -32601, f"Method not found: {method}")
            continue

        try:
            handler(req_id, params)
        except Exception as exc:  # noqa: BLE001
            log.exception("Handler %s raised: %s", method, exc)
            if req_id is not None:
                send_error(req_id, -32603, f"Internal error: {exc}")

    return 0
