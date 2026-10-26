/**
 * One tool call, told as a sentence a person can read: "Searched “bun
 * release” · 8 results from bun.sh, github.com" rather than
 * `websearch · "bun release"`. Present tense while it runs, past tense when
 * it is done, and a result line saying what came back.
 *
 * Pure and translation-agnostic: the caller passes `t` for the
 * `ChatStream.Narrate` namespace, so the timeline, its header and the step
 * strip all read the same sentence in English or Hindi.
 */

import { parseToolTiming } from "lib/ai/tools/timing";
import { editRowSummary, stepKindOf, type StepKind } from "lib/ai/tools/step-kind";
import {
  extractDomain,
  parseWebFetchOutput,
  parseWebSearchOutput,
} from "lib/web-search/parse-web-search";
import { parseAskUser } from "./ask-user";

export type NarrateT = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export interface StepStatusProps {
  input: any;
  output: any;
  status: "pending" | "success" | "error";
  errorText?: string;
}

export interface StepNarration {
  /** "Searching the web for “x”" / "Searched “x”". */
  title: string;
  /** What came back, one line: "8 results from bun.sh, github.com". */
  detail?: string;
  /** The colour family on the timeline and the step strip. */
  kind: StepKind | "ask";
}

const clip = (s: string, n = 72) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

const dirName = (p: string) => {
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `${p.startsWith("/") ? "/" : ""}${parts.join("/")}` : "";
};

function firstLine(text: unknown): string {
  if (typeof text !== "string") return "";
  const line = text.split("\n").find((l) => l.trim());
  return line ? clip(line.trim(), 90) : "";
}

/** The visible output of a shell call, whatever shape it came back in. */
function commandOutput(output: any): string {
  if (typeof output === "string") return parseToolTiming(output).cleanText ?? output;
  return output?.output ?? output?.stdout ?? "";
}

/** The amiro tool behind a generic `mcp` call, or the tool's own name. */
function innerToolName(toolName: string, input: any): string {
  if ((toolName === "mcp" || toolName === "mcp_call") && typeof input?.tool === "string") {
    return input.tool;
  }
  return toolName.replace(/^mcp__[^_]+__/, "");
}

const READ = new Set(["read", "read_file", "open"]);
const LIST = new Set(["ls", "list_dir"]);
const FIND = new Set(["glob", "grep"]);
const WRITE = new Set(["write", "write_file"]);
const FETCH = new Set(["webfetch", "webContent", "browser", "http"]);
const SEARCH = new Set(["websearch", "webSearch"]);

export function narrateStep(
  t: NarrateT,
  toolName: string,
  props: StepStatusProps,
): StepNarration {
  const { input, output, status } = props;
  const phase = status === "pending" ? "now" : status === "error" ? "failed" : "done";
  const kind = stepKindOf(toolName, input);
  const inner = innerToolName(toolName, input);
  const say = (key: string, values?: Record<string, string | number>) =>
    t(`${key}.${phase}`, values);

  if (inner.endsWith("ui_ask_user")) {
    const asked = status === "success" ? parseAskUser(output) : null;
    const count =
      asked?.questions.length ??
      (Array.isArray(input?.questions)
        ? input.questions.length
        : Array.isArray(input?.arguments?.questions)
          ? input.arguments.questions.length
          : 1);
    return { kind: "ask", title: say("ask", { count }) };
  }

  if (SEARCH.has(toolName)) {
    const parsed = parseWebSearchOutput(output, input?.query);
    const query = clip(input?.query ?? parsed.query ?? "", 60);
    const sites = Array.from(new Set(parsed.hits.map((h) => h.domain).filter(Boolean)))
      .slice(0, 3)
      .join(", ");
    return {
      kind: "search",
      title: say("search", { query }),
      detail:
        status === "success"
          ? parsed.hits.length
            ? t("search.results", { count: parsed.hits.length, sites })
            : t("search.none")
          : undefined,
    };
  }

  if (FETCH.has(toolName)) {
    const parsed = parseWebFetchOutput(output, input?.url);
    const url = parsed.url || input?.url || "";
    const host = extractDomain(url) || clip(url, 48);
    return {
      kind: "search",
      title: say("fetch", { host }),
      detail: status === "success" && parsed.title ? clip(parsed.title) : undefined,
    };
  }

  if (kind === "command") {
    const command = clip(firstLine(output?.command ?? input?.command ?? "") || inner, 60);
    const exit = typeof output?.exit_code === "number" ? output.exit_code : undefined;
    const out = firstLine(commandOutput(output));
    return {
      kind,
      title: say("command", { command }),
      detail:
        status === "error"
          ? firstLine(props.errorText) || undefined
          : status === "success"
            ? exit && exit !== 0
              ? t("command.exit", { code: exit })
              : out || undefined
            : undefined,
    };
  }

  if (kind === "edit") {
    const row = editRowSummary(toolName, props);
    const path = row?.path ?? input?.file_path ?? input?.path ?? "";
    const file = baseName(path) || t("aFile");
    const isWrite = WRITE.has(toolName);
    const created = row?.verb === "Created";
    const key = isWrite ? (status === "success" && !created ? "rewrite" : "write") : "edit";
    return {
      kind,
      title: say(key, { file }),
      detail:
        status === "success"
          ? isWrite && row?.removed === undefined
            ? t("lines", { count: row?.added ?? 0 })
            : `+${row?.added ?? 0} −${row?.removed ?? 0}`
          : status === "error"
            ? firstLine(props.errorText) || undefined
            : dirName(path) || undefined,
    };
  }

  if (READ.has(toolName)) {
    const path = output?.path ?? input?.file_path ?? input?.path ?? input?.target ?? "";
    return {
      kind,
      title: say("read", { file: baseName(path) || t("aFile") }),
      detail: dirName(path) || undefined,
    };
  }

  if (LIST.has(toolName)) {
    const path = output?.path ?? input?.path ?? ".";
    return { kind, title: say("list", { path: clip(path, 48) }) };
  }

  if (FIND.has(toolName)) {
    const pattern = clip(output?.pattern ?? input?.pattern ?? "", 48);
    const count = typeof output?.count === "number" ? output.count : undefined;
    return {
      kind,
      title: say("find", { pattern }),
      detail: status === "success" && count !== undefined ? t("matches", { count }) : undefined,
    };
  }

  if (kind === "plan") {
    return { kind, title: say("plan") };
  }

  // Anything else: the model's own one-line intent reads best when it gave
  // one; otherwise name the tool plainly.
  const intent =
    typeof input?.intent === "string" && input.intent.trim()
      ? clip(input.intent.trim())
      : typeof input?.description === "string" && input.description.trim()
        ? clip(input.description.trim())
        : "";
  const tool = inner.replace(/_/g, " ");
  return {
    kind,
    title: intent || say("tool", { tool }),
    detail: intent ? tool : undefined,
  };
}

/** The first sentence of a block of reasoning, for a folded thought. */
export function thoughtPreview(text: string, max = 110): string {
  const flat = text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  const sentence = flat.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? flat;
  return clip(sentence, max);
}
