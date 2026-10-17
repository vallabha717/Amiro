# Agent visual brief: dot-matrix agent character

Internal notes. Research + design brief only, no source changes. Convention matches
`docs/_notes-frontend.md`. Every claim is tagged **[V]** = verified by fetching the page/asset
or reading the repo, **[I]** = inferred. We copy nothing; assets stay reference-only.

## 1. Named references, one line each

| Name | One-line identity | URL | Tag |
|---|---|---|---|
| CopilotKit | Open-source agent/Generative-UI company; org logo mark is a faceted blue/purple **kite**, not a dot or spark | https://github.com/CopilotKit · https://www.copilotkit.ai · mark: https://raw.githubusercontent.com/CopilotKit/CopilotKit/main/examples/integrations/langgraph-python/public/copilotkit-logo-mark.svg | [V] |
| OpenDots | **Best match:** `CopilotKit/OpenDots`, MIT, ~5.4k★: always-on AI coworkers in text/calls/Slack; its agent avatars are **plush "Dot" characters**, one per agent | https://github.com/CopilotKit/OpenDots · https://www.copilotkit.ai/opendots | [V] |
| OpenMuse | **Best match:** `CopilotKit/openmuse`, MIT, ~5.1k★: personal agent (browser, terminal, files); mascot is an **original warm-tan capybara PNG** | https://github.com/CopilotKit/openmuse · https://www.copilotkit.ai/openmuse | [V] |
| Muse | **Ambiguous, 2 candidates:** (a) **Meta Muse**, proprietary personal AI agent (announced 8 Sep 2026; user picks name/avatar; "Realtime Avatar" video model added 23 Sep 2026); (b) CopilotKit **OpenMuse** above. (a) is the stronger read of the owner's single word | (a) https://ai.meta.com/muse/ · https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ · https://en.wikipedia.org/wiki/Muse_(AI_agent) ; (b) https://github.com/CopilotKit/openmuse | [V] for both existing; [I] for which was meant |
| GitHub Copilot | GitHub's AI coding product (separate company from CopilotKit): glossy blue/indigo **3D visor-head** mascot on dark backgrounds | https://github.com/features/copilot · https://images.ctfassets.net/8aevphvgewt8/4KxWJH8PVVXdqBLs1V3UJ8/8926c7d150a8b8f3bf33c1c8a133724b/github-copilot-social-img.png | [V] |
| Vellum | `vellum.ai` personal assistant: the look to avoid: default "character avatar" is an **SVG character composed from body shapes + eye styles + colours**, rendered to PNG, swapped via `set_avatar`/`remove_avatar`/`get_avatar` | https://www.vellum.ai/docs/key-concepts/the-workspace.md | [V] |

**Premise correction [V]:** there is no "GitHub Copilot dot/spark motif in CopilotKit". CopilotKit
≠ GitHub Copilot; CopilotKit's mark is a kite, and its agent visuals are mascots. The dot/spark
association is [I]: Copilot Chat shows a sparkle-style affordance in IDE/GitHub chrome (not
verified by fetch).

**Ambiguity, other "opendots" candidates [V, GitHub API]:** https://github.com/Anil-matcha/open-dots
(5.8k★, description claims MIT but **no LICENSE file exists**: no grant),
https://github.com/Shashankss1205/OpenDots (34★ MIT), https://github.com/diggerhq/opendots (24★ MIT).
Other "openmuse": https://github.com/nano-muse/nanoMuse (1.2k★ **GPL-3.0-or-later**),
https://github.com/DominiqueMakowski/OpenMuse (99★, no licence, unrelated EEG headband library).
Dot-matrix prior art for the palette/motion vocabulary below (visual reference only, not to vendor):
https://github.com/zzzzshawn/matrix (623★, custom proprietary licence),
https://github.com/icantcodefyi/dot-matrix-animations (87★, no licence found).

## 2. Visual motif + motion per reference [all V unless noted]

- **OpenDots / Dots.** Four 512×512 RGBA PNGs at `public/dots/{blue,mint,orange,purple}.png`:
  fluffy plush blobs, huge glossy eyes; variants differ by silhouette (blue = round + headphones,
  mint = tall + leaf ears). Which one an agent gets is a hash of its identity string, so identity is
  stable across reloads. `favicon.svg` is a flat vector face in a 64px rounded square (`rx=18`,
  bg `#e8edff`, body `#778bed`, eyes `#263360`). CSS states: `working` = `bob` (`translateY(-5px)`,
  2s ease-in-out infinite); `complete` = `rotate(-3deg)`; `needs-input` = `rotate(6deg)`; `paused` =
  `saturate(.5)`; call view `speaking` = `scale(1.06) translateY(-4px)` 1.5s. Sizes: hero 210px
  (3° tilt, floating "sparks", 9px caption), default 180px, small 54px, nav 30px. Both animation
  blocks are disabled under `prefers-reduced-motion: reduce`. The README screenshots show an
  **earlier flat periwinkle blob** (two dark oval eyes, blush cheeks, smile, ground-shadow ellipse
  at ~44px) beside the agent name in chrome: that flat variant is stale relative to shipped art.
- **OpenMuse.** One capybara PNG, "original artwork generated for OpenMuse with the built-in
  image-generation tool", provenance + generation prompt documented in `apps/mobile/assets/README.md`,
  MIT. `Mascot` composes a rounded backdrop circle (`size*0.76`, offset 0.15/0.12) behind the image
  using `sky #ECF5FA` / `sand #FAF0DF` / `lilac #F1ECF9`; the user's choice persists as
  `avatar: "sky" | "sand" | "lilac"`. Sizes in use: 94, 62, and 42 default.
- **Meta Muse.** Product surface, not a repo: agent name, avatar image and communication style are
  user-set; a Realtime Avatar model enables video conversations with a visual agent. Its actual
  avatar art is proprietary and could not be fetched ([I]).
- **Vellum.** Catalog shape: interchangeable body/eye/colour parts, user-upload or generated
  override, PNG output. Aesthetic is soft cartoon-character, hero-sized, on a light canvas.

## 3. Licence verdicts

| Repo | Verdict |
|---|---|
| CopilotKit/OpenDots | **MIT** (LICENSE file + API `spdx_id`): reusable, but the 4 plush PNGs are implicitly under the same MIT; still do not copy art |
| CopilotKit/openmuse | **MIT**; `apps/mobile/assets/README.md` states the capybara asset is included under the repo's MIT. Do not reuse: it is their identity |
| CopilotKit/CopilotKit (org) | **MIT**; logo mark/wordmark = trademark, licence does not grant brand use |
| GitHub Copilot, Meta Muse, Vellum | **Proprietary: no reuse of any asset or mark** |
| Anil-matcha/open-dots, DominiqueMakowski/OpenMuse, icantcodefyi/dot-matrix-animations | **No licence found** (GitHub license API: Not Found): treat as all rights reserved |
| nano-muse/nanoMuse | **GPL-3.0-or-later**: copyleft; avoid ingesting its code, and its default dragon art is theirs |
| zzzzshawn/matrix (dot-matrix loaders) | **Custom proprietary licence**: reuse is allowed in products, but republishing components as a standalone reusable component is prohibited. Using it as a *visual reference only* is safe; do not vendor its SVGs |

## 4. Design brief: original dot-matrix agent character

Working codename `lattice`. Nothing above is copied: no plush, no capybara, no body-shape/eye-style
catalog, no image assets.

**Geometry.** One inline `<svg viewBox="0 0 112 112">`, a fixed **7×7 lattice** (16px cell, 7px dot
diameter, 9px gutter). Cells are `(col,row)`, 0-indexed. Body = a 49-char map string (`.` empty,
`o` dot, `#` eye) so the silhouette is data, not path art. 6–8 silhouette variants chosen by a stable
hash of the agent id, so a given agent always looks the same. Edge dots get `r = 0.9 * r_core` so the
outline erodes rather than reading as a square. Exactly one of {silhouette, brows, base tilt} must be
left/right asymmetric, so it never reads as a symmetric glyph. Keep ≥1 empty cell of margin on all
four sides.

**Eyes and gaze.** An eye is always **two adjacent dots (2×1)**, never one dot: single-pixel eyes
alias away below ~28px. Eyes sit at columns 2–3 and 5–6 on row 3, giving a 2-cell face gap that makes
gaze legible. Ink: eyes `currentColor` at 100%, body dots at 55–65% opacity: the luminance gap is
what reads as "a face" at 20px. Gaze = shifting the eye mask within a ±1 col / ±1 row window, driven
by a 7–9s random walk plus pointer proximity; never a 0ms jump, never crossing into col 0/6, never
merging the two clusters.

**Motion vocabulary** (all transform/opacity only; ≤4 animated properties at once):
`breathe` whole stack `translateY 0→-1.5%` 4.2s + dot opacity 0.90→1.00 · `ripple` single-pass
outward wave, 90ms stagger per ring · `blink` `scaleY 1→0.12→1` over 60/120/90ms, ≥4.5s apart, ≤2 in
5s · `work` ripple loop 600ms from the last active cell + 4° sway 6s · `think` three cells orbiting
the silhouette perimeter at 2.4s/rev · `error` one 120ms ±1-cell two-frame jitter then settle, no
strobe · `done` one 300ms outward pulse then rest. Under `prefers-reduced-motion: reduce`: static
pose, loops off, state changes still land within 200ms via a 3s opacity crossfade. No `filter: blur`
or SVG filters at ≤64px.

**Colour, light and dark.** Monochrome by default and token-driven: `color-mix(in oklab, currentColor
58%, transparent)` for body dots, `currentColor` for eyes, `--primary` allowed on ≤12 cells as a
state accent. In dark theme invert the ramp (body 42%, eyes 100%) and add a 0.5px halo stroke of
`--background` at 22% so eye dots do not bloom. Never fill more than ~8% of the avatar area with a
saturated colour; the avatar must read as monochrome at 16px. Amiro already exposes `--background`,
`--foreground`, `--primary` in `src/app/globals.css` across its oklch/hsl theme blocks, so the
character must look right in all of them without new tokens.

**Acceptance criteria (browser-checkable).**
1. One `<svg>` per instance, no `<img>`: at 20 / 24 / 32 / 64 / 128 / 240px the Network panel shows
   **zero** image requests for the avatar, and layout is identical across sizes.
2. At 20px, a 1-bit screenshot still resolves **two** eye clusters (≥2 dots each) and no dot touches
   the viewBox edge (≥1 empty cell margin on all four sides).
3. Moving the pointer across the avatar changes the eye columns; the clusters never touch col 0/6 and
   never merge into one cluster, at any pointer position.
4. Each state (idle / work / think / error / done) becomes visually distinct within 200ms of
   triggering, confirmed by a screenshot pair diffing ≥2% of the avatar's area.
5. With `prefers-reduced-motion: reduce` emulated in the Rendering panel, two screenshots 3s apart are
   pixel-identical (diff 0), while a state change still repaints within 200ms.
6. At 200% browser zoom and in a 56px-wide container, measured gutter ≥1.2× dot diameter (no overlap)
   and each eye cluster is ≥5 CSS px wide.
7. In both light and dark themes, sampled pixels give eyes ≥3:1 against `--background` and ≥1.6:1
   against body dots, and the frame contains at most two hue families.
8. With 12 avatars on one page, Performance shows no long task >50ms and no per-frame style
   recalculation; each avatar sits on its own composited layer.

## 5. Decision (implemented)

The owner chose the **OpenDots** reference over the original `lattice` brief. The four
plush PNGs from `CopilotKit/OpenDots` (MIT, Copyright (c) Atai Barkai, see
`THIRD-PARTY-NOTICES.md`) are now the Agent avatar. Shipped:

- `public/agent/opendots/{blue,mint,orange,purple}.png`, copied verbatim from
  `CopilotKit/OpenDots@main public/dots/`.
- `src/lib/agent/opendots-catalog.ts`, the four variants plus the map from Amiro's six
  persisted body ids onto them (`blob`/`urchin`/`ghost` -> blue, `sprout` -> mint,
  `star` -> orange, `cloud` -> purple; unknowns -> blue), so saved agents stay stable.
- `src/components/agent/avatar-primitives.tsx`, one `<svg width={size}>` per instance
  holding an `<image href>` of the sprite plus a per-instance tint.
- Midnight renders the mascot as black plush: the sprite is desaturated, its
  luminance is gamma-darkened, and an overlay applies the tint so cut-out, glossy eyes
  and highlights stay intact.
- Theme synchronization: selecting an agent theme in the customizer updates the
  sidebar theme on save, and selecting a theme in the sidebar user menu commits the
  corresponding color trait to agent identity so both stay in sync across reloads.

**Tint.** The body hue follows `var(--sidebar-primary)` (overridable with the
`accentColor` prop for theme previews). The sprite is desaturated with an SVG
`feColorMatrix` (`saturate 0`), then a `mix-blend-mode: color` rect takes the tint's hue
and saturation while keeping the sprite's luminance, so the glossy black eyes, soft
shading and white highlights survive. The rect is alpha-masked to the sprite so the
transparent corners stay transparent. `prefers-reduced-motion` disables the idle bob, and
custom uploads are unchanged.

The acceptance criteria in section 4 described the lattice avatar and no longer apply;
they are kept above as the rejected-design record. The adapter browser assertion for
`svg > path` is superseded by the sprite `<image>` contract.
