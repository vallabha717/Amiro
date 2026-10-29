/**
 * The `ui_ask_user` question card: finding it in a tool result and turning
 * the user's picks into the reply message.
 *
 * The backend tool answers with `ASK_USER {json}` in its text (see
 * backend/src/agent_mcp.rs). The tool reaches the chat under several names --
 * bare, `mcp__amiro__…`, or wrapped in a generic `mcp` call -- so the card is
 * found from the result text, not the tool name.
 */

export interface AskUserOption {
  label: string;
  description?: string | null;
}

export interface AskUserQuestion {
  id: string;
  question: string;
  header?: string | null;
  options: AskUserOption[];
  multiSelect: boolean;
}

export interface AskUserRequest {
  questions: AskUserQuestion[];
}

/** What the user picked for one question. */
export interface AskUserAnswer {
  selected: string[];
  other?: string;
}

const MARKER = "ASK_USER";

/** Every string inside a tool output, in order. */
function collectText(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectText(v, out, depth + 1);
    }
  }
}

/** The balanced `{...}` starting at `start`, or null if it never closes. */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function coerce(raw: any): AskUserRequest | null {
  if (!raw || !Array.isArray(raw.questions)) return null;
  const questions: AskUserQuestion[] = [];
  raw.questions.forEach((q: any, i: number) => {
    if (!q || typeof q.question !== "string" || !q.question.trim()) return;
    const options: AskUserOption[] = (Array.isArray(q.options) ? q.options : [])
      .filter((o: any) => o && typeof o.label === "string" && o.label.trim())
      .map((o: any) => ({
        label: o.label.trim(),
        description:
          typeof o.description === "string" ? o.description : undefined,
      }));
    if (options.length < 1) return;
    questions.push({
      id: typeof q.id === "string" && q.id ? q.id : `q${i + 1}`,
      question: q.question.trim(),
      header: typeof q.header === "string" ? q.header : undefined,
      options,
      multiSelect: Boolean(q.multiSelect ?? q.multi_select),
    });
  });
  return questions.length ? { questions } : null;
}

/** The question card a tool result carries, or null. */
export function parseAskUser(output: unknown): AskUserRequest | null {
  const texts: string[] = [];
  collectText(output, texts);
  for (const text of texts) {
    const at = text.indexOf(MARKER);
    if (at < 0) continue;
    const brace = text.indexOf("{", at + MARKER.length);
    if (brace < 0) continue;
    const json = balancedObject(text, brace);
    if (!json) continue;
    try {
      const request = coerce(JSON.parse(json));
      if (request) return request;
    } catch {
      // A malformed card is not a card; keep looking.
    }
  }
  return null;
}

/**
 * The JSON object that follows `MARKER {` in a tool result, or null. The plan
 * and walkthrough cards ride the same text convention as the question card.
 */
export function parseMarkerJson(
  output: unknown,
  marker: string,
): Record<string, any> | null {
  const texts: string[] = [];
  collectText(output, texts);
  const needle = `${marker} {`;
  for (const text of texts) {
    const at = text.indexOf(needle);
    if (at < 0) continue;
    const json = balancedObject(text, at + marker.length + 1);
    if (!json) continue;
    try {
      const value = JSON.parse(json);
      if (value && typeof value === "object") return value;
    } catch {
      // A malformed card is not a card; keep looking.
    }
  }
  return null;
}

/** True when the answer to this question has something in it. */
export function isAnswered(answer: AskUserAnswer | undefined): boolean {
  if (!answer) return false;
  return answer.selected.length > 0 || Boolean(answer.other?.trim());
}

/**
 * The reply sent on the user's behalf: one line per question, so the agent
 * reads the answers as plainly as if they had been typed.
 */
export function formatAskUserReply(
  request: AskUserRequest,
  answers: Record<string, AskUserAnswer>,
): string {
  const lines = request.questions.map((q) => {
    const a = answers[q.id];
    const picks = [...(a?.selected ?? [])];
    const other = a?.other?.trim();
    if (other) picks.push(other);
    return `- ${q.question} → ${picks.length ? picks.join(", ") : "(no answer)"}`;
  });
  return lines.join("\n");
}
