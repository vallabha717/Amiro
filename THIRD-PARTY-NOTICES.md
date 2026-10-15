# Third-party notices

## Agent character art

The Agent avatar system in `src/lib/agent/character-catalog.ts` and
`src/components/agent/avatar-primitives.tsx` is original to this repository.

Nothing in it is imported artwork or third-party path data. Each body is
generated at runtime from a compact radial-field definition (a few cosine
harmonics plus an optional stem or hem), which is traced into the silhouette
path and reused to place the dot lattice; each gaze style is likewise generated
code (circles, rings and stroked arcs). The earlier Vellum-derived catalogue was
removed in full, so `grep -ri vellum src/` returns nothing.

Vellum Assistant remains an architectural reference for Amiro and is MIT
licensed, but no Vellum code, geometry or brand asset is copied into this
repository.
