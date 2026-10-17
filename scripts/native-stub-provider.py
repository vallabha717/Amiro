#!/usr/bin/env python3
"""Minimal OpenAI-compatible provider stub for Amiro acceptance checks.

Serves exactly what the Amiro runtime asks a chat-completions provider for: a
model catalog and a streamed completion. It exists so the native backend's chat
path can be exercised end to end (real runtime, real session, real streamed
events) without spending a real provider's quota.

This is test tooling, never part of the product. `start-native-ui-check.sh`
starts it and points the runtime at it with AMIRO_OPENAI_COMPAT_API_BASE.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPLY = "Hello from the local stub provider."


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
                {"object": "list", "data": [{"id": "stub-model", "object": "model"}]}
            )
            return
        self._json({"error": {"message": "not found"}}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        if not self.path.startswith("/v1/chat/completions"):
            self._json({"error": {"message": "not found"}}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def chunk(delta, finish_reason=None):
            payload = {
                "id": "chatcmpl-stub",
                "object": "chat.completion.chunk",
                "model": "stub-model",
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
            "model": "stub-model",
            "choices": [],
            "usage": {"prompt_tokens": 7, "completion_tokens": 8, "total_tokens": 15},
        }
        self.wfile.write(f"data: {json.dumps(usage)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 38951
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
