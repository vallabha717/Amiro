#!/usr/bin/env python3
"""Minimal OpenAI-compatible provider stub for Amiro acceptance checks.

Serves exactly what the Amiro runtime asks a chat-completions provider for: a
model catalog and a streamed completion. It exists so the native backend's chat
path can be exercised end to end (real runtime, real session, real streamed
events) without spending a real provider's quota.

This is test tooling, never part of the product. `start-native-ui-check.sh`
starts it and points the runtime at it with AMIRO_OPENAI_COMPAT_API_BASE.

Two optional switches exist so a check can prove which model actually reached
the provider and whether tools were on. Both are unset by default, and with
both unset the stub answers exactly as it always has.

  AMIRO_STUB_EXPECT_MODEL  every chat-completions request must name exactly this
                           model, otherwise the stub answers 400 instead of a
                           completion. A caller that silently falls back to a
                           daemon default is caught here rather than passing.
  AMIRO_STUB_REQUEST_LOG   append-only JSONL, one line per chat-completions
                           request: {"model": ..., "toolsCount": ...}. It records
                           only those two fields (no prompt, no headers, no
                           credentials), so it is safe to keep as evidence.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPLY = "Hello from the local stub provider."
DEFAULT_MODEL = "stub-model"

EXPECTED_MODEL = (os.environ.get("AMIRO_STUB_EXPECT_MODEL") or "").strip()
REQUEST_LOG = (os.environ.get("AMIRO_STUB_REQUEST_LOG") or "").strip()


def catalog_ids():
    """Model ids this stub advertises.

    Default is exactly one model, unchanged. With AMIRO_STUB_EXPECT_MODEL set,
    the catalog also carries the scheduled-run model, so a check can hold a
    daemon default and a saved per-schedule model apart as two valid routes and
    still have the completion endpoint accept only the expected one.
    """
    ids = [DEFAULT_MODEL]
    if EXPECTED_MODEL:
        for extra in (EXPECTED_MODEL, "stub-scheduled-model"):
            if extra not in ids:
                ids.append(extra)
    return ids


def record_request(model, tools_count):
    """Append {model, toolsCount} to AMIRO_STUB_REQUEST_LOG, if configured."""
    if not REQUEST_LOG:
        return
    line = json.dumps({"model": model, "toolsCount": tools_count}, sort_keys=True)
    try:
        with open(REQUEST_LOG, "a", encoding="utf-8") as handle:
            handle.write(f"{line}\n")
    except OSError as error:
        # Never fail the completion over the log; a missing line fails the
        # check that reads it, which is the loud outcome, not a silent one.
        print(f"stub provider: could not write {REQUEST_LOG}: {error}", file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        # Keep the acceptance output readable.
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._json(
                {
                    "object": "list",
                    "data": [
                        {"id": model_id, "object": "model"}
                        for model_id in catalog_ids()
                    ],
                }
            )
            return
        self._json({"error": {"message": "not found"}}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not self.path.startswith("/v1/chat/completions"):
            self._json({"error": {"message": "not found"}}, 404)
            return

        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            record_request(None, 0)
            self._json(
                {"error": {"message": "stub provider received a body that is not JSON"}},
                400,
            )
            return
        if not isinstance(payload, dict):
            payload = {}

        model = payload.get("model")
        tools = payload.get("tools")
        tools_count = len(tools) if isinstance(tools, list) else 0
        record_request(model, tools_count)

        if EXPECTED_MODEL and model != EXPECTED_MODEL:
            self._json(
                {
                    "error": {
                        "message": (
                            f"stub provider expected model {EXPECTED_MODEL!r} "
                            f"but received {model!r}"
                        )
                    }
                },
                400,
            )
            return

        stream_model = model if isinstance(model, str) and model else DEFAULT_MODEL

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def chunk(delta, finish_reason=None):
            payload = {
                "id": "chatcmpl-stub",
                "object": "chat.completion.chunk",
                "model": stream_model,
                "choices": [
                    {"index": 0, "delta": delta, "finish_reason": finish_reason}
                ],
            }
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
            self.wfile.flush()

        chunk({"role": "assistant", "content": ""})
        for piece in REPLY.split(" "):
            chunk({"content": piece + " "})
        chunk({}, "stop")
        usage = {
            "id": "chatcmpl-stub",
            "object": "chat.completion.chunk",
            "model": stream_model,
            "choices": [],
            "usage": {"prompt_tokens": 7, "completion_tokens": 8, "total_tokens": 15},
        }
        self.wfile.write(f"data: {json.dumps(usage)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 38951
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
