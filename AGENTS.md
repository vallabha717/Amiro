# Agent instructions for Amiro

**When coding anything, follow
[`.agents/skills/develop-feature/SKILL.md`](.agents/skills/develop-feature/SKILL.md)**:
orient → backend → UI → test → finish, loading
[`amiro-standards`](.agents/skills/amiro-standards/SKILL.md) (where things go,
rules), `backend`, `ui` and `test` at the right step. Contributor rules live in [CONTRIBUTING.md](CONTRIBUTING.md); other task
skills in [`.agents/skills/`](.agents/skills/README.md). The rules below apply
to every change an agent makes.

## Every user-facing change ships with an E2E journey step

If you add or change anything a user can see or trigger — a page, setting,
form, agent tool, connector or auth flow, voice behaviour, onboarding step —
add or update the matching step in the recorded Playwright journeys in
`tests/e2e/specs/` in the same change, then run that journey:

```bash
pnpm --dir tests e2e --project <journey>
```

Follow [`.agents/skills/e2e-journeys/SKILL.md`](.agents/skills/e2e-journeys/SKILL.md):
which journey owns which surface, how to add a value the user must supply to
`tests/e2e.config.example.json`, and how to keep secrets out of the chat.
Check the recorded `tests/recordings/<stamp>/suites/<journey>.mp4` before
calling the work done.

## Secrets never go through chat

Agent tools that need a key, token or password must ask for it with the secure
secret card (`ui_prompt_secret` / `SECRET_PROMPT`) or an OAuth card, never in
plain text. The E2E journeys assert this; keep them passing.

## Languages

The UI ships English and Hindi only. Every new string goes into both
`messages/en.json` and `messages/hi.json`.
