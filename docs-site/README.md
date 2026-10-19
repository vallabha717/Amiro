# Amiro docs (Mintlify)

Usage-first documentation for Amiro. Mintlify v2 format: `docs.json` plus
`.mdx` pages. This is the user guide, not an internals manual.

## Layout

- `docs.json` — site config and tab navigation (Get started, Using Amiro,
  Settings, Reference)
- `introduction.mdx`, `quickstart.mdx`, `installation.mdx`, `first-run.mdx`
- `using/` — 12 task guides: chatting, threads, personalizing, skills,
  memory, workspace files, voice, schedules, search, connectors,
  credentials, export
- `settings/` — app tour, account, providers, troubleshooting
- `reference/` — power-user API overviews plus CLI essentials and FAQ

## Preview locally

```bash
npx mintlify dev
```

Or deploy by connecting this repo's `docs-site` folder in the Mintlify
dashboard.

## Conventions

Every page starts with `title` and `description` frontmatter. Internal links
use root-relative paths such as `/using/schedules`. Components used: `Steps`,
`Step`, `Tabs`, `Tab`, `Accordion`, `AccordionGroup`, `Card`, `CardGroup`,
`Note`, `Warning`, `Tip`, `Info`. No em dashes, no emojis.
