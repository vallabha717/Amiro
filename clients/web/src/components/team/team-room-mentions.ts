/**
 * The @word being typed just before the caret, without the `@`, or null when
 * the caret is not inside one. `@` must start the text or follow whitespace,
 * so an email address never opens the agent list.
 */
export function mentionQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  return match ? match[2] : null;
}

/**
 * Replaces the @word before the caret with `@name ` (or adds it at the caret
 * when none is being typed). Returns the new text and caret position.
 */
export function insertMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const query = mentionQuery(text, caret);
  const start = query === null ? caret : caret - query.length - 1;
  const lead = query === null && start > 0 && !/\s$/.test(text.slice(0, start)) ? " " : "";
  const inserted = `${lead}@${name} `;
  const after = text.slice(caret).replace(/^\s+/, "");
  return {
    text: text.slice(0, start) + inserted + after,
    caret: start + inserted.length,
  };
}

/** Agents whose name starts with (or contains) the query, best matches first. */
export function matchAgents<T extends { name: string }>(agents: T[], query: string): T[] {
  const q = query.toLowerCase();
  const starts = agents.filter((a) => a.name.toLowerCase().startsWith(q));
  const contains = agents.filter(
    (a) => !a.name.toLowerCase().startsWith(q) && a.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}
