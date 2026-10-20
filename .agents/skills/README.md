# Skills

This directory holds agent skills: self-contained bundles of guidance (and,
sometimes, scripts) that an agent reads when a task matches what the skill
covers. There is no code anywhere in this repo that registers or loads
`SKILL.md` files — the convention below is the entire mechanism. Getting the
shape right is what makes a skill actually get picked up; there is no build
step, import, or manifest to also update.

## Layout

```
.agents/skills/<skill-name>/
  SKILL.md          # required — frontmatter + guidance, kept short
  reference/*.md    # optional — deep detail, linked from SKILL.md, read on demand
  scripts/*         # optional — runnable helpers (.mjs/shell), invoked via the terminal tool
```

- **One directory per skill**, named in kebab-case. The directory name and
  the frontmatter `name:` must match (e.g. `.agents/skills/backend/`,
  `name: backend`).

## The skills that live here

| Skill | Covers |
| --- | --- |
| [`develop-feature`](develop-feature/SKILL.md) | **Use when coding anything.** The step-by-step workflow (orient → backend → UI → test → finish) that tells you when to load each skill below. |
| [`amiro-standards`](amiro-standards/SKILL.md) | **Start here.** Where every kind of change goes, folder structure and naming, frontend/backend/runtime rules, English+Hindi i18n, secrets, definition of done, commit conventions, and which skill to load next. Installed globally for every agent (see "Global install" below). |
| [`backend`](backend/SKILL.md) | Rust backend (`backend/`, axum): folder structure, where a route goes, auth, errors, JSON store, credential vault, agent tools, backend tests. |
| [`ui`](ui/SKILL.md) | Next.js frontend (`src/`, static export): folder structure, pages vs components, API clients, SWR/zustand, styling tokens, English+Hindi i18n, a11y, test ids. |
| [`test`](test/SKILL.md) | Which test layer proves which change (Vitest, type-check/lint, backend integration, runtime crates, E2E journeys) and the end-of-feature test run. |
| [`e2e-journeys`](e2e-journeys/SKILL.md) | Recorded Playwright journeys in `tests/e2e/`: how to run them, how every user-facing change adds a journey step, config for user-supplied keys, and the video/`REVIEW.md` output. |
| [`plan`](plan/SKILL.md) | How work gets planned — the phased plan-folder method behind `docs/testing/`. Produces `docs/<initiative>/` with design docs, `phases/`, and a seeded `progress/`. Writes documents, never code. |
| [`implement`](implement/SKILL.md) | How a planned phase gets executed and recorded: entry conditions, building to the `ui`/`backend` standards, verifying every exit criterion by running it, then writing the progress record and verification log. Its Go/`tests/` commands are historical. |

`develop-feature` is the everyday loop for a single feature or fix.
`plan` → `implement` is the loop for a multi-phase initiative. Both load
`amiro-standards`, `backend`, `ui` and `test` (plus `e2e-journeys`) for the
standards they build to —
so a phase is planned with its test coverage and shipped with it, on every
surface it reaches. Each of `plan` and `implement` keeps its templates in
sibling `*-TEMPLATE.md` files — the progressive-disclosure pattern
described below.

## SKILL.md frontmatter

```yaml
---
name: skill-name
description: One dense paragraph naming what the skill is for AND when to
  trigger it. This is the only text used to decide whether the skill applies
  to a given task, so front-load the trigger words a user would actually say.
disable-model-invocation: true   # optional — see below
---
```

- `name` — must equal the folder name.
- `description` — the single most important sentence in the file. It has to
  work standalone, without the body, because that's what gets matched
  against the task. State the domain, then explicit trigger phrasing
  ("use when asked to run/start/test the app locally…").
- `disable-model-invocation: true` — add this when the skill should only run
  if explicitly named or requested, not auto-triggered by task similarity.
  Use it for narrow lookup tools where a false-positive auto-trigger would be
  annoying. None of the five skills here set it: all five should kick in
  whenever the task matches, which is the default and the common case.

## Body

- Start with an `# H1` title.
- Write for an agent mid-task, not a human skimming docs: short, imperative,
  answer-first. Prefer tables and recipes over prose paragraphs.
- Keep `SKILL.md` itself short (most existing skills are under ~100 lines).
  If the topic needs exhaustive reference material, a rule catalog, or a
  template, push it into a same-directory file and link to it — that's
  progressive disclosure, and it's why `SKILL.md` stays skimmable while the
  detail is still one hop away when actually needed (see
  `plan/PHASE-TEMPLATE.md`, `implement/PROGRESS-TEMPLATE.md`).
- If the skill carries executable helpers, put them under `scripts/` next to
  `SKILL.md`. They're invoked by the agent through the terminal, not
  imported by the app — nothing in `src/` or `backend-go/` depends on them.

## Steps to add a new skill

1. Pick a kebab-case name; create `.agents/skills/<name>/`.
2. Copy `.agents/skills/_template/SKILL.md` into the new folder and fill in
   the frontmatter and body (or start from scratch, but the template exists
   to keep the shape consistent).
3. Decide the trigger mode: default (auto-invoked when the description
   matches) vs. `disable-model-invocation: true` (explicit-invoke only).
4. Write the guidance. Match the tone of `backend/SKILL.md` — short,
   imperative, table-heavy — rather than writing a design doc.
5. If the skill needs deep reference material or scripts, split those into
   `reference/*.md` or `scripts/*` and link to them from `SKILL.md`.
6. Nothing else to wire up — the skill is live as soon as the folder exists
   with a correctly-shaped `SKILL.md`.

## Global install (every agent on this machine)

`develop-feature` and the skills it references (`amiro-standards`, `backend`,
`ui`, `test`, `e2e-journeys`) are symlinked into the global skill folders so any agent
(Claude Code, jcode/Amiro runtime, Codex-style `.agents` readers) picks it up
in any directory, always from this repo's current copy:

```bash
bash scripts/install-global-skills.sh          # links develop-feature and the skills it uses
bash scripts/install-global-skills.sh --check  # show where each link points
```

Links: `~/.agents/skills/<name>`, `~/.claude/skills/<name>`,
`~/.jcode/skills/<name>`. Re-running is safe; it never overwrites a real
directory of the same name.
