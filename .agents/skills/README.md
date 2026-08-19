# Adding skills

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
  the frontmatter `name:` must match (e.g. `.agents/skills/ask-sonner/`,
  `name: ask-sonner`).
- Existing examples worth reading before writing a new one: `ask-sonner`
  (a guide skill with a companion `API.md`), `pick-ui-library` (a lookup
  skill, explicit-invoke only), `local-dev-vm` (a short how-to with no
  companion files), `improve-animations` (a multi-phase workflow skill with
  `AUDIT.md`/`PLAN-TEMPLATE.md` reference files).

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
  annoying (see `pick-ui-library`). Leave it off for skills that should kick
  in whenever the task matches, which is the default and the common case.

## Body

- Start with an `# H1` title.
- Write for an agent mid-task, not a human skimming docs: short, imperative,
  answer-first. Prefer tables and recipes over prose paragraphs.
- Keep `SKILL.md` itself short (most existing skills are under ~100 lines).
  If the topic needs exhaustive reference material, a rule catalog, or a
  template, push it into a same-directory file and link to it — that's
  progressive disclosure, and it's why `SKILL.md` stays skimmable while the
  detail is still one hop away when actually needed (see `ask-sonner/API.md`,
  `improve-animations/AUDIT.md` + `PLAN-TEMPLATE.md`).
- If the skill carries executable helpers, put them under `scripts/` next to
  `SKILL.md` (see `impeccable/scripts/`). They're invoked by the agent
  through the terminal, not imported by the app — nothing in `src/` or
  `backend-go/` depends on them.

## Steps to add a new skill

1. Pick a kebab-case name; create `.agents/skills/<name>/`.
2. Copy `.agents/skills/_template/SKILL.md` into the new folder and fill in
   the frontmatter and body (or start from scratch, but the template exists
   to keep the shape consistent).
3. Decide the trigger mode: default (auto-invoked when the description
   matches) vs. `disable-model-invocation: true` (explicit-invoke only).
4. Write the guidance. Match the tone of `ask-sonner` or `pick-ui-library`
   rather than writing a design doc.
5. If the skill needs deep reference material or scripts, split those into
   `reference/*.md` or `scripts/*` and link to them from `SKILL.md`.
6. Nothing else to wire up — the skill is live as soon as the folder exists
   with a correctly-shaped `SKILL.md`.
