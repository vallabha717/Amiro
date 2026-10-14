# Windows counterpart to build-sidecar.sh.
#
# The Go backend (backend-go/cmd/server) used to be cross-compiled here into
# src-tauri/binaries/backend-<triple>.exe for Tauri's externalBin slot. It is
# replaced by adapter/src/server.mjs, a plain Node (>=22) server.
#
# Tauri's externalBin slot on Windows requires a real .exe. A Node script
# cannot occupy it, and this script will not pretend otherwise by writing a
# .cmd/.bat with an .exe name (Tauri would copy it and then fail to execute
# it). Producing a real Windows sidecar means packaging the adapter as a Node
# SEA / single executable (or bundling a Node binary and adding it to
# externalBin) -- a follow-up. Until then, Windows `tauri dev` has no packaged
# sidecar; run the adapter directly and point the frontend at it:
#
#     node adapter/src/server.mjs          # binds 0.0.0.0:8787
#     $env:NEXT_PUBLIC_BACKEND_URL="http://127.0.0.1:8787"
#     pnpm dev -p 3210

Write-Error @"
backend-go has been removed and the Windows Tauri sidecar cannot be built
from the Node adapter yet (externalBin needs a real .exe; see the comment at
the top of src-tauri/build-sidecar.ps1).

Run the adapter directly instead:
  node adapter/src/server.mjs
  `$env:NEXT_PUBLIC_BACKEND_URL='http://127.0.0.1:8787'
  pnpm dev -p 3210
"@
exit 1
