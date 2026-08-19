---
name: skill-name-here
description: One dense paragraph stating what this skill covers and when it
  should trigger — name the domain and the trigger phrasing a user would
  actually type ("use when asked to X, Y, or Z"). This is the only text an
  agent sees when deciding whether the skill applies, so it has to stand on
  its own without the body below.
# Uncomment if this skill should only run when explicitly named/requested,
# never auto-triggered by task similarity (see .agents/skills/pick-ui-library):
# disable-model-invocation: true
---

# Title Matching The Skill's Purpose

One or two sentences: what this skill does, and what it deliberately does
NOT do (scope it against neighboring skills if any exist).

## <First real section — e.g. "Setup", "How to use this", "Workflow">

Write for an agent mid-task, not a human skimming documentation:
short, imperative, answer-first. Prefer a table or a numbered recipe
over a paragraph wherever the content is a lookup or a sequence.

| Situation | What to do |
| --- | --- |
| … | … |

## <Second section — e.g. "Recipes", "Common mismatches", "Troubleshooting">

Concrete, copy-pasteable guidance. Code blocks where useful.

## Notes

- Delete this template's placeholder text — nothing here should survive into
  the real skill.
- Rename this directory from `_template` (or wherever you copied it to) to
  the kebab-case skill name, matching frontmatter `name:` exactly.
- Keep this file short. If the skill needs a rule catalog, an API reference,
  a plan template, or anything else exhaustive, put it in a sibling file
  (e.g. `reference.md`, `API.md`) and link to it from here instead of
  inlining it — see `.agents/skills/ask-sonner/API.md` or
  `.agents/skills/improve-animations/AUDIT.md` for the pattern.
- If the skill needs runnable helpers, put them in `scripts/` next to this
  file; they're invoked via the terminal tool, not imported by the app.
