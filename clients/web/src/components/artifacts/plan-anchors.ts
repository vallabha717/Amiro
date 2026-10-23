import { splitMarkdownBlocks } from "lib/markdown-blocks";
import type { PlanComment } from "./use-artifacts";

/**
 * Anchoring comments into a document the agent will rewrite.
 *
 * The hard part is not attaching a comment, it is what happens on the *next*
 * proposal. The agent revises the plan in response to the comments, so by the
 * time the user sees their note again the text under it has usually moved and
 * may be gone entirely.
 *
 * Two mechanisms, and the reason for each:
 *
 *   - The anchor is the **quoted text**, not a position. A block index or a
 *     character offset is invalidated by any edit above it, which is every
 *     revision. A quote survives the document being reordered, and it is also
 *     the only form the *model* can act on -- "on «X»: your note" is a
 *     complete instruction, "on block 4: your note" is not.
 *   - The block hash is carried alongside, and used only as a hint for where
 *     to *draw* the comment. It is deliberately not part of matching: a block
 *     the agent reworded should still show its comment, attached to whatever
 *     block now contains the quoted text.
 *
 * A quote that no longer appears anywhere is reported as `outdated` rather
 * than dropped. That distinction is the point: a comment vanishing silently
 * looks like the app lost it, when what actually happened is that the agent
 * answered the objection by deleting the thing objected to -- which the user
 * needs to be able to see and confirm.
 *
 * The plan itself is never rewritten here. The user's side of this exchange is
 * comments only: what they object to is anchored prose the agent has to
 * answer, not a patch applied behind its back.
 */

export interface PlanBlock {
  id: string;
  source: string;
  /** Nearest heading at or above this block, without its `#` markers. */
  section?: string;
}

/**
 * A stable id for a block, derived from its own text.
 *
 * Not a random id and not an index. Random would change on every render of
 * the same document; an index would make every anchor below an edit point at
 * the wrong block. Content-derived means identical text keeps its identity
 * across a revision that did not touch it, which is the common case.
 *
 * FNV-1a: short, dependency-free, and its only job is bucketing comments in
 * a document of a few dozen blocks. Collisions cost a comment drawn beside
 * the wrong paragraph, not a wrong decision.
 */
export function blockId(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/** Nearest-heading tagging, shared by the original split and the edited view. */
function tagSections(blocks: Omit<PlanBlock, "section">[]): PlanBlock[] {
  let section: string | undefined;
  return blocks.map((block) => {
    const heading = block.source.split("\n")[0]?.match(HEADING);
    if (heading) section = heading[2].trim();
    return { ...block, section };
  });
}

/** Split a plan into addressable blocks, each tagged with its section. */
export function planBlocks(markdown: string): PlanBlock[] {
  return tagSections(
    splitMarkdownBlocks(markdown).map((source) => ({
      id: blockId(source),
      source,
    })),
  );
}

/** Normalized for comparison: whitespace collapsed, case preserved. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export type AnchorState =
  | { kind: "attached"; blockId: string }
  /** The quote is gone from the document -- usually because it was rewritten. */
  | { kind: "outdated" };

/**
 * Where a comment should be drawn against the current version of the plan.
 *
 * Matching is on normalized text so a quote that spans a line wrap in the
 * source still matches. Whitespace is the one difference between "the same
 * sentence" and "a different sentence" that a reader would never call a
 * difference.
 */
export function anchorState(
  comment: Pick<PlanComment, "quote" | "blockId">,
  blocks: PlanBlock[],
): AnchorState {
  const quote = normalize(comment.quote);
  if (!quote) return { kind: "outdated" };

  // The recorded block first: when nothing moved, this is the answer and it
  // avoids a comment jumping to a coincidental match elsewhere.
  const recorded = blocks.find((b) => b.id === comment.blockId);
  if (recorded && normalize(recorded.source).includes(quote)) {
    return { kind: "attached", blockId: recorded.id };
  }

  const moved = blocks.find((b) => normalize(b.source).includes(quote));
  if (moved) return { kind: "attached", blockId: moved.id };

  return { kind: "outdated" };
}

/** Group comments by the block they currently attach to. */
export function commentsByBlock(
  comments: PlanComment[],
  blocks: PlanBlock[],
): { attached: Map<string, PlanComment[]>; outdated: PlanComment[] } {
  const attached = new Map<string, PlanComment[]>();
  const outdated: PlanComment[] = [];

  for (const comment of comments) {
    const state = anchorState(comment, blocks);
    if (state.kind === "outdated") {
      outdated.push(comment);
      continue;
    }
    const list = attached.get(state.blockId) ?? [];
    list.push(comment);
    attached.set(state.blockId, list);
  }
  return { attached, outdated };
}

/**
 * Trim a selection down to something worth quoting.
 *
 * A selection long enough to include half the document is not an anchor, it
 * is a copy, and it would match nothing after any revision. Capping it keeps
 * the anchor specific enough to survive one and short enough to read in the
 * gutter.
 */
export function normalizeQuote(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= 240) return text;
  return `${text.slice(0, 240)}…`;
}
