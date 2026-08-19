# Feature-parity closeout — 2026-08-10

Closed every real gap vs. reference `better-chatbot` found by a full audit:

1. MCP tool/server @-mentions wired into live chat tool-calling
2. Workflows callable as chat tools via @-mention
3. Agents' system prompt + bound tools applied to live chat
4. Multimodal attachments (images/files) actually reach the model
5. Real network token streaming (replaced word-chunked fake stream)
6. Admin user-management panel — built backend from scratch (list/search/
   role/ban/delete), frontend was previously a placeholder
7. MCP OAuth for remote servers — full RFC 9728/8414/7591/7636 client
   built from scratch (`internal/mcp/oauth`)

Found + fixed 6 real bugs live along the way (OAuth popup postMessage
origin mismatch, OAuth re-auth loop, `toolInfo: null` crash, two SSE
error-framing 500s, several unguarded `message.parts` reads).

Backend (`go build/vet/test ./...`) and frontend (`tsc`, `biome`,
`vitest`) all clean; everything also verified live against the running
dev servers, not just unit-tested.

Dummy line 1.
Dummy line 2.

Dummy line 3.
Dummy line 4.
Edited dummy line 5.
Edited dummy line 6.
Dummy line 7.
Dummy line 8.
