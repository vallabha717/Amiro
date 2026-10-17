# Third-party notices

## Rust agent runtime

`runtime/` contains a modified source fork of the MIT-licensed Jcode project by
Jeremy Huang, sourced from `1jehuang/jcode` at immutable commit
`11952e02ac76fa1c335633e9c6113691c1cf3395` (package version 0.98.1).
The native build targets this source as Amiro's runtime executable. Product names,
local crate names and application state paths are adapted for Amiro. This does
not transfer authorship of the upstream work or imply upstream endorsement.

The original MIT copyright and permission notice is retained in
`runtime/LICENSE`. Include that license with redistributed runtime binaries.
Vendored dependency license files and notices remain applicable. Details of the
fork and build verification are recorded in `docs/RUST-RUNTIME.md`.

The compatibility adapter still uses the separately installed
`@1jehuang/jcode-sdk` package. That package is an upstream dependency, not an
Amiro-authored library. Compatibility with an installed upstream engine does
not mean that engine has been bundled into an Amiro build.

## Agent character art

The Agent avatar rendered by `src/components/agent/avatar-primitives.tsx` uses the
four OpenDots plush sprites in `public/agent/opendots/`
(`blue.png`, `mint.png`, `orange.png`, `purple.png`).

Those PNGs are copied verbatim from **CopilotKit/OpenDots**
(https://github.com/CopilotKit/OpenDots), `public/dots/`, which is MIT licensed. The
originals are unmodified; the avatar recolours them at runtime with an
SVG luminance-preserving tint. The mapping from Amiro's persisted body ids onto the
four variants lives in `src/lib/agent/opendots-catalog.ts`.

```
The MIT License

Copyright (c) Atai Barkai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Retired lattice catalogue

`src/lib/agent/character-catalog.ts` (body-shape radial fields, eye marks, palette) is
original to this repository. Nothing in it is imported artwork or third-party path
data: each body was generated at runtime from a compact radial-field definition (a few
cosine harmonics plus an optional stem or hem), and each gaze style was likewise
generated code (circles, rings and stroked arcs). The dot-lattice avatar render that
consumed it has been replaced by the OpenDots sprites above; the catalogue's eye marks
are still used by the sidebar peek tab and assistant stage.

The earlier Vellum-derived catalogue was removed in full, so `grep -ri vellum src/`
returns nothing.

Vellum Assistant remains an architectural reference for Amiro and is MIT licensed, but
no Vellum code, geometry or brand asset is copied into this repository.
