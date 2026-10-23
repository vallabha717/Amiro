---
name: cli-discover
description: Discover which CLI tools are installed, their versions, and authentication status. Load it when a task depends on outside CLIs (gh, aws, docker, vercel, …) and you need to know what is available before planning the work.
allowed-tools: mcp_call
metadata:
  emoji: "🔍"
  amiro:
    category: "development"
    display-name: "CLI Discovery"
---

# CLI Discovery

When a task depends on outside CLI tools, discover what is available before planning the work. You (the chat agent) have no shell of your own, so discovery happens one of two ways — pick the first that fits:

1. **Ask a team agent with computer access** to run the checks below (via the team's task tools) and report back the version table.
2. **Ask the user** to paste the output of the checks below. Keep the ask to one short message with the exact commands.

Never claim a CLI exists because it usually does. A sandboxed or fresh machine is missing half of these, and auth state is per-machine — check, don't assume.

## Checking if a CLI exists

```bash
which <name>        # returns path if found, exits non-zero if missing
command -v <name>   # alternative, works in all POSIX shells
```

## Getting version info

```bash
<name> --version    # most CLIs support this flag
```

Use a 5-second timeout to avoid hanging on unresponsive CLIs.

## Auth-check commands

For CLIs that support authentication, check whether the machine is logged in:

| CLI       | Auth check command                                                |
| --------- | ----------------------------------------------------------------- |
| `gh`      | `gh auth status`                                                  |
| `aws`     | `aws sts get-caller-identity`                                     |
| `gcloud`  | `gcloud auth list --filter=status:ACTIVE --format=value(account)` |
| `az`      | `az account show`                                                 |
| `vercel`  | `vercel whoami`                                                   |
| `netlify` | `netlify status`                                                  |
| `fly`     | `fly auth whoami`                                                 |
| `heroku`  | `heroku auth:whoami`                                              |
| `railway` | `railway whoami`                                                  |

## Common CLIs worth checking

When doing a broad discovery, check these categories:

- **Version control & code hosting:** `gh`, `git`
- **Cloud providers:** `aws`, `gcloud`, `az`
- **Containers & infra:** `docker`, `kubectl`, `terraform`
- **Runtimes & package managers:** `node`, `bun`, `deno`, `python3`, `pip3`
- **HTTP clients:** `curl`
- **Hosting & deploy:** `vercel`, `netlify`, `fly`, `heroku`, `railway`

## Output format

Report findings in markdown:

```markdown
## Available CLIs

- **git** (/usr/bin/git) - git version 2.x.x
- **gh** (/usr/bin/gh) - gh version 2.x.x [authenticated: user@example.com]
- **bun** (~/.bun/bin/bun) - 1.x.x

## Not found: railway, fly, heroku
```

Then plan the task around what is actually there. If a required CLI is missing, say so plainly and offer the next step (install it on the machine that will run the work, or pick a tool that is already available) instead of working around it silently.

## Source

Ported from Vellum's `cli-discover` skill and adapted for Amiro: the chat agent has no shell of its own, so checks run on a team agent with computer access (sandbox `agent_shell`) or on the user's own machine.
