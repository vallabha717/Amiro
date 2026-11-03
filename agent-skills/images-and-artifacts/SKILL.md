---
name: images-and-artifacts
description: Make pictures and keep finished work as files the user can open later - images, documents, reports, exports and small HTML pages, shown in the Files tab. Load it whenever the user asks to draw, generate or design an image, logo or illustration, or to write a document, report, export or page they will keep, or to find, change or delete one made earlier.
allowed-tools: mcp_call
metadata:
  emoji: "🖼️"
  amiro:
    display-name: "Images & Files"
    category: "content"
---

These tools are on the built-in `amiro` server: `mcp_call { server: "amiro", tool: "<name>", intent: "...", arguments: {...} }`.

## Pictures

1. `image_generate` with a full description: subject, style, composition, colours, any text that must appear, and the aspect ratio if it matters. It takes up to a minute, saves the picture as an artifact and shows it in the chat.
2. If it says no image provider is set up, call `image_provider_status`, tell the user in one line, and offer to set it up (`image_provider_configure`; the key comes through the secure card, never chat).
3. For changes, generate again with the adjusted description and say what you changed.

Diagrams and charts are not pictures: use the `visualize` skill for those.

## Files the user keeps (artifacts)

Use an artifact whenever the result is something to open, download or come back to: a report, a plan, a letter, a CSV export, a one-page HTML site. Short answers stay in the chat.

| Tool | Use |
| --- | --- |
| `artifact_create` | New file: title, kind (markdown, html, code, csv, pdf, docx) and content. Saved under `workspace/artifacts` and shown in the Files tab |
| `artifact_list` | What already exists. Check before creating a second copy |
| `artifact_read` | Read one before changing it |
| `artifact_update` | Revise the title or content in place |
| `artifact_delete` | Remove one. Confirm first |

Write the whole document in the artifact, then say in one or two lines what it is and that it is in the Files tab. Don't paste the full content into the chat as well.
