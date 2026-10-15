# Observed public route boundaries

Run: `NODE_TLS_REJECT_UNAUTHORIZED=0 AMIRO_TEST_URL=https://194.238.18.234:8787 node adapter/test/route-boundaries.mjs` on October 14, 2026 at 2026-10-14T13:16:16.320Z. All 114 literal registered method/path entries were enumerated from the changed adapter and mapped below. See `requirement-traceability.md` for successful evidence (provider catalog, connected-provider models, folder browse, chat, ownership).

`Anon` is the actual unauthenticated HTTP status. `Owner GET` is a real owner-authenticated read smoke result. Parameterized URLs used `audit-missing` identifiers, so a 404 is a missing-resource boundary check, not successful CRUD acceptance. `Not run` means authenticated mutation was deliberately NOT performed. Every such mutation remains unverified for successful feature parity unless covered by the named integration/browser tests. Status 501 is an explicitly unsupported preview integration, not success. Rows marked `live auth test` are covered by live-smoke instead of repeating arbitrary login attempts.

| Registered public output | Anon | Owner GET |
| --- | --- | --- |
| GET /health | 200 | Not run |
| GET /api/auth/status | 200 | Not run |
| POST /api/auth/login | covered by live-smoke | Not run |
| POST /api/auth/register | covered by live-smoke | Not run |
| POST /api/auth/logout | 401 | Not run |
| GET /api/auth/session | 401 | 200 |
| POST /api/chat | 401 | Not run |
| POST /api/chat/temporary | 401 | Not run |
| POST /api/chat/title | 401 | Not run |
| POST /api/chat/export | 401 | Not run |
| POST /api/chat/openai-realtime | 401 | Not run |
| GET /api/chat/models | 200 | Not run |
| GET /api/ai/providers | 401 | 200 |
| POST /api/ai/providers | 401 | Not run |
| DELETE /api/ai/providers/:id | 401 | Not run |
| POST /api/ai/providers/models | 401 | Not run |
| POST /api/ai/providers/:id/test | 401 | Not run |
| POST /api/ai/generate-object | 401 | Not run |
| POST /api/ai/generate-example-tool-schema | 401 | Not run |
| GET /api/providers/login-status | 401 | 200 |
| GET /api/admin/users | 401 | 200 |
| GET /api/admin/users/:id/stats | 401 | 404 |
| GET /api/admin/users/:id | 401 | 404 |
| PUT /api/admin/users/:id/role | 401 | Not run |
| PUT /api/admin/users/:id/ban | 401 | Not run |
| DELETE /api/admin/users/:id | 401 | Not run |
| GET /api/archive | 401 | 200 |
| POST /api/archive | 401 | Not run |
| GET /api/archive/:id | 401 | 404 |
| PUT /api/archive/:id | 401 | Not run |
| DELETE /api/archive/:id | 401 | Not run |
| POST /api/archive/:id/items | 401 | Not run |
| GET /api/archive/:id/items | 401 | 404 |
| DELETE /api/archive/:id/items/:itemId | 401 | Not run |
| GET /api/background-jobs | 401 | 200 |
| POST /api/background-jobs | 401 | Not run |
| GET /api/background-jobs/:id | 401 | 404 |
| GET /api/checkpoint/files | 401 | 400 |
| POST /api/checkpoint/restore | 401 | Not run |
| GET /api/checkpoint/latest | 401 | 404 |
| GET /api/export | 401 | 200 |
| GET /api/export/:id | 401 | 404 |
| DELETE /api/export/:id | 401 | Not run |
| GET /api/export/:id/comments | 401 | 200 |
| POST /api/export/:id/comments | 401 | Not run |
| DELETE /api/export/:id/comments/:commentId | 401 | Not run |
| GET /api/fs/roots | 401 | 200 |
| GET /api/fs/browse | 401 | 400 |
| GET /api/fs/stat | 401 | 400 |
| GET /api/github/status | 401 | 200 |
| POST /api/github/connect | 401 | Not run |
| POST /api/github/disconnect | 401 | Not run |
| GET /api/mcp/list | 401 | 200 |
| POST /api/mcp | 401 | Not run |
| GET /api/mcp/servers/:id | 401 | 404 |
| DELETE /api/mcp/servers/:id | 401 | Not run |
| POST /api/mcp/servers/:id/refresh | 401 | Not run |
| POST /api/mcp/servers/:id/share | 401 | Not run |
| POST /api/mcp/servers/:id/tools/:tool/call | 401 | Not run |
| POST /api/mcp/servers/:id/oauth/authorize | 401 | Not run |
| GET /api/mcp/oauth/callback | 501 | Not run |
| GET /api/mcp/server-customizations/:server | 401 | 200 |
| POST /api/mcp/server-customizations/:server | 401 | Not run |
| DELETE /api/mcp/server-customizations/:server | 401 | Not run |
| GET /api/mcp/tool-customizations/:server | 401 | 200 |
| GET /api/mcp/tool-customizations/:server/:tool | 401 | 200 |
| POST /api/mcp/tool-customizations/:server/:tool | 401 | Not run |
| DELETE /api/mcp/tool-customizations/:server/:tool | 401 | Not run |
| POST /api/providers/:id/oauth/start | 401 | Not run |
| GET /api/providers/:id/oauth/status | 401 | 404 |
| POST /api/providers/:id/oauth/callback | 401 | Not run |
| DELETE /api/providers/:id/oauth | 401 | Not run |
| POST /api/providers/:id/oauth/cancel | 401 | Not run |
| GET /api/providers/catalog | 401 | 200 |
| POST /api/providers/:id/api-key | 401 | Not run |
| DELETE /api/providers/:id/credentials | 401 | Not run |
| GET /api/search/active | 401 | 501 |
| GET /api/search/catalog | 401 | 501 |
| GET /api/search/providers | 401 | 501 |
| POST /api/search/providers | 401 | Not run |
| DELETE /api/search/providers/:id | 401 | Not run |
| POST /api/search/providers/:id/activate | 401 | Not run |
| POST /api/search/providers/:id/test | 401 | Not run |
| GET /api/skills | 401 | 200 |
| GET /api/skills/items/:name | 401 | 404 |
| POST /api/skills | 401 | Not run |
| PUT /api/skills/items/:name | 401 | Not run |
| DELETE /api/skills/items/:name | 401 | Not run |
| POST /api/skills/items/:name/duplicate | 401 | Not run |
| POST /api/skills/generate | 401 | Not run |
| POST /api/storage/upload-url | 401 | Not run |
| PUT /storage/:token | 404 | Not run |
| GET /storage/:token | 404 | 404 |
| POST /api/storage/ingest | 401 | Not run |
| POST /api/storage/upload | 401 | Not run |
| GET /api/user/details | 401 | 200 |
| PUT /api/user/details | 401 | Not run |
| PUT /api/user/password | 401 | Not run |
| GET /api/user/auth-methods | 401 | 200 |
| GET /api/user/preferences | 401 | 200 |
| PUT /api/user/preferences | 401 | Not run |
| GET /api/user/stats | 401 | 404 |
| GET /api/user/details/:id | 401 | 404 |
| GET /api/workspace-trust | 401 | 200 |
| GET /api/workspace-trust/status | 401 | 400 |
| POST /api/workspace-trust/grant | 401 | Not run |
| POST /api/workspace-trust/revoke | 401 | Not run |
| GET /api/thread | 401 | 200 |
| GET /api/thread/:id | 401 | 404 |
| PUT /api/thread/:id | 401 | Not run |
| DELETE /api/thread/:id | 401 | Not run |
| DELETE /api/thread | 401 | Not run |
| DELETE /api/thread/messages/:id | 401 | Not run |
| POST /api/thread/messages/:id/truncate | 401 | Not run |

The machine-readable artifact `/root/.jcode/scratch/amiro-route-acceptance.json` also records the source file and the coverage limitation per row. Discovery covers literal `app.get/post/put/patch/delete` registrations, not future dynamic registration or every static frontend page. The earlier frontend inventory counted 105 caller contracts, a different population from these 114 adapter registrations.
