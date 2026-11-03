---
name: skill-builder
description: Turn a repeatable way of working into a skill the agent loads next time - write it, save it to the Superpowers page and make it available at once. Load it whenever the user asks to make, save, write, edit or delete a skill, or says "remember how to do this" or "do it this way every time" about a multi-step task.
allowed-tools: skill_manage, write, read, bash
metadata:
  emoji: "🧩"
  amiro:
    display-name: "Skill Builder"
    category: "productivity"
---

A skill is one `SKILL.md` file that tells you how to do a kind of task. The user's skills live in the runtime's skills folder, `${AMIRO_RUNTIME_HOME:-$AMIRO_HOME}/skills/<name>/SKILL.md` (run `echo ${AMIRO_RUNTIME_HOME:-$AMIRO_HOME}` for the path). Every skill there shows on the **Superpowers** page and loads when its description matches a request.

## Write it

1. Name: lowercase words joined by hyphens, at most 64 characters (`weekly-sales-report`). Check the name is free with `skill_manage` `action: "list"`.
2. Frontmatter, then the body:

```markdown
---
name: weekly-sales-report
description: What it does, then exactly when to load it ("Load it whenever the user asks for ..."). This line decides when the skill is used, so name the words people actually say.
metadata:
  amiro:
    display-name: "Weekly sales report"
    category: "productivity"
---

Steps in order, with the exact tools, servers, files and settings to use.
What a good result looks like, and what to do when something is missing.
```

3. Keep it short and specific: the tools and arguments that worked, the decisions the user made, the mistakes to avoid. Leave out anything a capable agent already knows. Never put a key, password or token in a skill.

## Save and use it

1. `write` the file to `<runtime home>/skills/<name>/SKILL.md`.
2. `skill_manage` `action: "reload_all"` so it is available now.
3. Tell the user its name and that it is on the Superpowers page, where they can read or edit it.

To change a skill, `read` it, edit, and reload. To delete one, confirm first, then remove its folder and reload. Built-in skills are replaced on every update: to change one, save a copy under a new name.
