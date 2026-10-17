# 02: Disclosure, activation, and the prompt

> **Shipped in Phase 1.** Implemented by `internal/ai/prompts`, `internal/ai/tools`, `internal/agent/workspace`, and `internal/api/chat`. Verified across backend unit and end-to-end integration suites.

Settled here: what the model is told about skills, how a skill's body
reaches the conversation, and why Amiro needs an activation tool rather
than letting the model `read_file` the `SKILL.md` itself.

## The three tiers

| Tier | Content | When | Cost |
|---|---|---|---|
| 1 · catalog | `name` + `description` per skill | every turn | ~50–100 tokens per skill |
| 2 · instructions | the `SKILL.md` body | on activation | target < 5k tokens |
| 3 · resources | `scripts/`, `references/`, `assets/` | when the body points at one | nothing until read |

## Tier 1: the catalog

A new section produced by `internal/ai/prompts` and merged into the system
prompt by the existing `MergeSystemPrompt` (`prompts.go:269`), alongside the
user prompt and the MCP-customizations section. Shape:

```xml
<available_skills>
  <skill>
    <name>code-review</name>
    <description>Reviews a diff for correctness and reuse. Use when the user asks to review changes.</description>
    <location>/home/u/.agents/skills/code-review/SKILL.md</location>
  </skill>
</available_skills>
```

Plus a short instruction block telling the model to call the activation tool
when a task matches a description. Rules:

- **Omit the whole section when no skills were discovered.** An empty
  `<available_skills/>` block and a registered tool with no valid values
  both actively mislead the model.
- Skills with `disable-model-invocation: true` are **hidden from the
  catalog entirely**, not listed-and-refused. They remain invocable from
  `/`. Listing a skill the model cannot load wastes turns.
- `description` is truncated at 1024 characters (the spec's own cap) and the
  whole catalog at 256 entries, matching the discovery bound.

## Tier 2: activation

**Amiro needs a dedicated tool, not a file read.** The file-read path the
guide describes first is the simplest option for most clients and is wrong
here for a concrete reason: Amiro's file tools are scoped to a single
`WorkspaceRoot` (`config.Config.WorkspaceRoot`, enforced through
`internal/ai/tools`), and user-scope skills live under `$HOME`, outside any
workspace. The options are to widen the file sandbox or to add a tool that
reads exactly the files skills own. Widening a sandbox to make a feature
work is how sandboxes stop meaning anything, so: a tool.

`skill(name)`: read-only, no approval prompt in any permission mode
(including `plan`), because reading a local text file the user installed is
not a mutation:

- `name` is an **enum constrained to the discovered set**, so the model
  cannot invoke a skill that does not exist.
- Returns the **body with frontmatter stripped**, wrapped for
  identification, with the skill directory stated and bundled resources
  enumerated but *not* read:

```xml
<skill_content name="code-review">
[body]
Skill directory: /home/u/.agents/skills/code-review
Relative paths in this skill resolve against that directory.
<skill_resources>
  <file>references/checklist.md</file>
  <file>scripts/diffstat.sh</file>
</skill_resources>
</skill_content>
```

- Resource listing is capped (32 files) and says so when truncated.
- The tool is **not registered at all** when no skills were discovered.

## Tier 3: reading bundled resources

The model will want `references/checklist.md` after reading the body. Two
things must be true, and both are Phase 1 deliverables:

1. The file tools accept **additional read-only roots** beyond
   `WorkspaceRoot`: the directories of skills activated this turn, and
   nothing else. Read-only, never write/edit/delete, never a shell cwd.
2. Those roots are **allowlisted for approval**, so a skill that bundles
   three reference files does not produce three permission dialogs. This is
   the guide's own warning, and it is what makes bundled resources usable
   rather than nominally supported.

## User-explicit activation

The harness intercepts the selection and injects; the model does not act.

- A `/`-selected skill (web palette or TUI palette) is attached to the
  **next** turn as a pending selection, exactly as `@`-mentions already are
  (`pendingMentions` in `page/chat.go`, `mentions` in `prompt-input.tsx`).
- The chat request carries it as a new discriminated-union member,
  `{ type: "skill", name }` in `ChatMentionSchema`, so it travels the
  existing `mentions` array on both surfaces and needs no new request field.
  The backend resolves it in `internal/api/chat/mentions.go` next to
  `resolveAgent`, and injects the same `<skill_content>` block the tool
  would have returned, before the first model call.
- **Explicit selection ignores `disable-model-invocation`**: that field
  stops the model from choosing, not the user.
- A selected name that no longer resolves (skill deleted between palette
  open and send) is reported inline like an unknown slash command, never
  silently dropped and never forwarded to the model as literal `/foo` text.

## Keeping it effective

- **Activation is deduplicated per turn.** The same skill selected by the
  user and then chosen by the model appears once.
- **Skill content is exempt from compaction.** `/compact` and automatic
  history trimming must not drop a `<skill_content>` block: losing it
  degrades every later turn with no visible error. The wrapper tags exist
  so the compaction path can recognise it.
- **Skill activations are events.** The chat event stream already carries
  tool activity to both UIs; an activation emits one, so a user can see
  *which* skill shaped an answer. This is also what the cross-surface test
  asserts on.
