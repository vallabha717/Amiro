import { type UIMessage, isToolUIPart } from "ai";
import { previewKindOf, workspacePathFrom } from "./kinds";

export interface ChatFile {
  /** Workspace-relative path. */
  path: string;
  name: string;
}

// Paths in prose: relative or workspace-rooted, ending in a real extension.
const PATH_IN_TEXT =
  /(?:(?:~\/|\/)?(?:[\w.@-]+\/)*[\w.@ -]*?)[\w@-][\w.@-]*\.[A-Za-z][A-Za-z0-9]{0,5}/g;

const INPUT_KEYS = ["path", "file_path", "filePath", "filename", "file", "output", "destination"];

function fromText(text: string, out: Set<string>) {
  // Fenced code is skipped: a path inside a code sample is not a file the chat produced.
  const prose = text.replace(/```[\s\S]*?```/g, " ");
  for (const m of prose.matchAll(/`([^`\n]{1,300})`/g)) {
    const p = workspacePathFrom(m[1]);
    if (p) out.add(p);
  }
  for (const m of prose.matchAll(/\]\(([^)\s]{1,300})\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    const p = workspacePathFrom(decodeURI(m[1]));
    if (p) out.add(p);
  }
  for (const m of prose.matchAll(PATH_IN_TEXT)) {
    const raw = m[0].trim();
    if (!raw.includes("/")) continue;
    const p = workspacePathFrom(raw);
    if (p && previewKindOf(p) !== "unsupported") out.add(p);
  }
}

function fromInput(input: unknown, out: Set<string>) {
  if (!input || typeof input !== "object") return;
  for (const key of INPUT_KEYS) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v !== "string") continue;
    const p = workspacePathFrom(v);
    if (p) out.add(p);
  }
}

/**
 * Every workspace file the conversation names: paths the agent or the user
 * wrote in text or links, and the files its tools read or wrote. Like the
 * other artifacts this is a projection of the transcript, so a reload finds
 * the same list.
 */
export function chatFilesFrom(messages: UIMessage[]): ChatFile[] {
  const seen = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.text) fromText(part.text, seen);
      else if (isToolUIPart(part)) fromInput((part as { input?: unknown }).input, seen);
    }
  }
  return Array.from(seen, (path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) }));
}
