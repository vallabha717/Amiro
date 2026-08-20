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

## The five skills that live here

| Skill | Covers |
| --- | --- |
| [`ui`](ui/SKILL.md) | Standards for anything a user sees: `src/**` (the Next.js dashboard, which ships to the Tauri desktop app, to the browser via `amiro serve`, and to `next dev`) and `backend-go/internal/tui/**` (the terminal UI). Folder structure, static-export constraints, backend access, styling tokens, i18n, state. |
| [`backend`](backend/SKILL.md) | Standards for `backend-go/**`: package layout, adding an API route, the three auth guards, dual-dialect migrations, repositories, secrets, providers, MCP, build tags, and the test gates. |
| [`test`](test/SKILL.md) | Standards for the `tests/` harness and how every change gets proven end to end across all five surfaces: where a test goes, how to write one, the fake provider and cassettes, golden screens, the `suites/meta/` guards that fail the build on an untested route, and the selection commands. |
| [`plan`](plan/SKILL.md) | How work gets planned — the phased plan-folder method behind `docs/testing/`. Produces `docs/<initiative>/` with design docs, `phases/`, and a seeded `progress/`. Writes documents, never code. |
| [`implement`](implement/SKILL.md) | How a planned phase gets executed and recorded: entry conditions, building to the `ui`/`backend` standards, verifying every exit criterion by running it, then writing the progress record and verification log and updating every doc the phase invalidated. |

`plan` → `implement` is the intended loop. Both of them load `test`, and
`implement` also loads `ui` and `backend` for the standards it builds to —
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
