"use client";

import { cn } from "lib/utils";
import { MessageSquarePlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "ui/button";
import { Markdown } from "../markdown";
import {
  type PlanBlock,
  commentsByBlock,
  normalizeQuote,
  planBlocks,
} from "./plan-anchors";
import type { PlanComment } from "./use-artifacts";

interface PendingAnchor {
  quote: string;
  blockId: string;
  section?: string;
  /** Viewport position of the anchor, for placing the composer. */
  top: number;
  left: number;
}

/** The line under the cursor, in coordinates relative to the document. */
interface HoveredLine extends Omit<PendingAnchor, "top" | "left"> {
  /** Box of the line, relative to the scrolling document container. */
  top: number;
  height: number;
  /** Viewport position, carried through to the composer on click. */
  viewportTop: number;
  viewportLeft: number;
}

interface Props {
  markdown: string;
  comments: PlanComment[];
  onAdd: (comment: Omit<PlanComment, "id">) => void;
  onRemove: (id: string) => void;
  /** Read-only unless the plan is actionable (fully written, awaiting a decision). */
  readonly?: boolean;
  /** True while the model is still writing this plan. Draws a trailing cursor on the last block. */
  isStreaming?: boolean;
}

/**
 * The line-level units a comment can be anchored to.
 *
 * A "line" here is the smallest rendered thing a reader would point at: one
 * list item, one paragraph, one heading, one table *cell*. Cells rather than
 * rows because the anchor is quoted text matched against the markdown source
 * (see plan-anchors) -- a row's `textContent` runs its cells together with no
 * separator, so `| src/foo.ts | why |` would never match the quote taken from
 * it, while a single cell matches exactly.
 */
const LINE_SELECTOR = "li, p, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre";

/**
 * The plan document: readable and commentable, never editable.
 *
 * Blocks are rendered through the existing `Markdown` component rather than a
 * second renderer, so a table in a plan looks exactly like a table in a chat
 * message. The only thing added around each block is a wrapper carrying its
 * id, which is what lets an anchor be traced back to the block it landed in
 * without parsing the DOM.
 *
 * # Two ways to anchor, one composer
 *
 * Selecting text anchors to the selection. Hovering anchors to the *line*
 * under the cursor -- the affordance a reader reaches for when the whole
 * bullet is the thing they object to and dragging across it is busywork.
 * Both open the same composer and produce the same quoted comment, because
 * they are the same act: point at part of the plan, say what is wrong with it.
 *
 * # Why the user cannot edit the plan
 *
 * A comment says "this is wrong, and here is why", and leaves the fix to the
 * agent, which knows what else in the plan depends on the part being objected
 * to. Letting the user rewrite a block directly takes that judgement back
 * from the only party positioned to exercise it: change one row of a file
 * table and every later phase that assumed the old row is quietly wrong, with
 * nobody checking. So the document is read-only and the feedback is prose.
 */
export function CommentableMarkdown({
  markdown,
  comments,
  onAdd,
  onRemove,
  readonly,
  isStreaming,
}: Props) {
  const t = useTranslations("Chat.Artifact");
  const containerRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingAnchor | null>(null);
  const [draft, setDraft] = useState("");
  const [hovered, setHovered] = useState<HoveredLine | null>(null);

  /** Touch has no hover and finishes a selection after pointer-up. */
  const touchRef = useRef(false);

  const blocks = useMemo<PlanBlock[]>(() => planBlocks(markdown), [markdown]);

  const { attached, outdated } = useMemo(
    () => commentsByBlock(comments, blocks),
    [comments, blocks],
  );

  /**
   * Capture the selection once it is finished.
   *
   * Pointer-up and key-up rather than a `selectionchange` subscription: the
   * selection is only meaningful once the user has stopped making it, and
   * reacting to every intermediate range would make the composer chase the
   * cursor across the paragraph while they are still dragging. Key-up is
   * there because shift+arrow is how someone without a pointer selects, and
   * it is the whole keyboard path into commenting.
   */
  const captureSelection = useCallback(() => {
    if (readonly) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return;
    const quote = normalizeQuote(selection.toString());
    if (!quote) return;

    // The range's start, not the selection's anchor: dragged upwards, the
    // anchor is where the drag ended, the last block of the quote.
    const anchorNode = selection.getRangeAt(0).startContainer;
    const element =
      anchorNode?.nodeType === Node.ELEMENT_NODE
        ? (anchorNode as HTMLElement)
        : anchorNode?.parentElement;

    // Text selected inside the composer is someone reading their own note
    // back, not someone quoting the plan.
    if (element?.closest("textarea")) return;

    const block = element?.closest<HTMLElement>("[data-block-id]");
    if (!block || !containerRef.current?.contains(block)) return;

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setHovered(null);
    setPending({
      quote,
      blockId: block.dataset.blockId!,
      section: block.dataset.section || undefined,
      top: rect.bottom,
      left: rect.left,
    });
    setDraft("");
  }, [readonly]);

  /**
   * Track which line the cursor is over.
   *
   * One delegated handler on the container rather than a wrapper element per
   * line: the lines are produced by the markdown renderer, and reaching inside
   * its output to wrap every `<li>` would mean a second renderer and a plan
   * that stops looking like a chat message. `closest` reads the same structure
   * back out, and the affordance is drawn in an overlay beside it.
   */
  const trackLine = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (readonly || pending) return;
      // A held mouse button is a selection being dragged: the line button
      // would chase the cursor and land under the release point.
      if (event.pointerType === "mouse" && event.buttons) {
        setHovered(null);
        return;
      }
      const container = containerRef.current;
      const target = event.target as HTMLElement | null;
      if (!container || !target) return;

      // Moving onto the affordance itself must not count as leaving the line
      // it belongs to -- that would make the button vanish under the cursor
      // on its way to being clicked.
      if (target.closest("[data-line-affordance]")) return;

      const line = target.closest<HTMLElement>(LINE_SELECTOR);
      if (!line || !container.contains(line)) {
        setHovered(null);
        return;
      }
      const block = line.closest<HTMLElement>("[data-block-id]");
      if (!block) {
        setHovered(null);
        return;
      }
      const quote = normalizeQuote(line.textContent ?? "");
      if (!quote) {
        setHovered(null);
        return;
      }

      const rect = line.getBoundingClientRect();
      const base = container.getBoundingClientRect();
      const next: HoveredLine = {
        quote,
        blockId: block.dataset.blockId!,
        section: block.dataset.section || undefined,
        top: rect.top - base.top,
        height: rect.height,
        viewportTop: rect.bottom,
        viewportLeft: rect.left,
      };
      // Pointer-move fires per pixel; a fresh object every time would
      // re-render the whole document on each one. Only a *different* line is
      // a change worth reacting to.
      setHovered((prev) =>
        prev &&
        prev.quote === next.quote &&
        prev.blockId === next.blockId &&
        prev.top === next.top
          ? prev
          : next,
      );
    },
    [readonly, pending],
  );

  /**
   * Touch: a tap shows the line's comment button (there is no hover to do
   * it), and a long-press selection is captured once its handles stop
   * moving -- on a phone the selection is still changing after pointer-up.
   */
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      touchRef.current = event.pointerType !== "mouse";
      if (touchRef.current) trackLine(event);
    },
    [trackLine],
  );

  useEffect(() => {
    if (readonly) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      if (!touchRef.current) return;
      clearTimeout(timer);
      timer = setTimeout(captureSelection, 500);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [readonly, captureSelection]);

  const commentOnLine = useCallback(() => {
    if (!hovered) return;
    setPending({
      quote: hovered.quote,
      blockId: hovered.blockId,
      section: hovered.section,
      top: hovered.viewportTop,
      left: hovered.viewportLeft,
    });
    setDraft("");
    setHovered(null);
  }, [hovered]);

  // Escape abandons a draft. A composer with no way out but submitting is
  // how a stray double-click turns into an empty comment on the plan.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPending(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  const submit = useCallback(() => {
    const note = draft.trim();
    if (!pending || !note) return;
    onAdd({
      quote: pending.quote,
      blockId: pending.blockId,
      section: pending.section,
      note,
    });
    setPending(null);
    setDraft("");
    document.getSelection()?.removeAllRanges();
  }, [draft, pending, onAdd]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="relative"
        onPointerDown={onPointerDown}
        onPointerUp={captureSelection}
        onKeyUp={captureSelection}
        onPointerMove={trackLine}
        onPointerLeave={(e) => {
          // A finger lifting "leaves" too; keep the tapped line's button.
          if (e.pointerType === "mouse") setHovered(null);
        }}
      >
        {blocks.map((block, i) => {
          const blockComments = attached.get(block.id) ?? [];
          const isLastBlock = i === blocks.length - 1;

          return (
            <div
              key={block.id}
              data-block-id={block.id}
              data-section={block.section}
              className={cn(
                "relative rounded-md -mx-2 px-2",
                // A commented block is tinted, not outlined: an outline on a
                // table adds a second border next to the one the table
                // already has, and the two read as a rendering bug.
                blockComments.length > 0 && "bg-amber-500/[0.07]",
              )}
            >
              {/* isStreaming only applies to the last block -- earlier ones
                  are already settled text and gain nothing from the cursor
                  except a needless re-render on every delta. */}
              <Markdown isStreaming={isStreaming && isLastBlock}>
                {block.source}
              </Markdown>

              {blockComments.length > 0 && (
                <div className="flex flex-col gap-1.5 pb-2">
                  {blockComments.map((comment) => (
                    <CommentBubble
                      key={comment.id}
                      comment={comment}
                      onRemove={readonly ? undefined : onRemove}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {hovered && !readonly && (
          <>
            {/* The line the affordance belongs to, said rather than implied.
                Without it a button floating in the gutter is ambiguous in
                exactly the case granularity matters -- a tight list, where
                the next bullet is four pixels away. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -mx-2 rounded bg-amber-500/[0.06] motion-safe:transition-[top,height] motion-safe:duration-100"
              style={{ top: hovered.top, height: hovered.height }}
            />
            <button
              type="button"
              data-line-affordance
              data-testid="plan-comment-line"
              onClick={commentOnLine}
              aria-label={t("commentOnLine")}
              title={t("commentOnLine")}
              className={cn(
                "absolute right-0 z-10 -translate-y-1/2 rounded-full border bg-background/90 p-2 text-muted-foreground shadow-sm backdrop-blur-sm sm:p-1",
                "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100",
              )}
              style={{ top: hovered.top + hovered.height / 2 }}
            >
              <MessageSquarePlusIcon className="size-3.5" />
            </button>
          </>
        )}
      </div>

      {outdated.length > 0 && (
        <div className="mt-4 rounded-lg border border-dashed p-3">
          <p className="text-[11px] font-medium text-muted-foreground mb-2">
            {/* Shown, not dropped: a comment disappearing looks like the app
                lost it, when what happened is that the text it was about is
                gone -- the agent rewrote it in response to this very comment.
                That is worth seeing before it is sent again. */}
            {t("outdatedComments")}
          </p>
          <div className="flex flex-col gap-1.5">
            {outdated.map((comment) => (
              <CommentBubble
                key={comment.id}
                comment={comment}
                outdated
                onRemove={readonly ? undefined : onRemove}
              />
            ))}
          </div>
        </div>
      )}

      {pending && (
        <div
          className="fixed z-[60] w-[min(18rem,calc(100vw-1rem))] rounded-lg border bg-popover shadow-lg p-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150"
          style={{
            // Kept on screen on a phone too, where the selection may sit at
            // the very edge and the keyboard takes the bottom half.
            top: Math.max(8, Math.min(pending.top + 8, window.innerHeight - 200)),
            left: Math.max(8, Math.min(pending.left, window.innerWidth - 296)),
          }}
        >
          <p className="text-[11px] text-muted-foreground line-clamp-2 border-l-2 border-amber-500/60 pl-2 mb-2">
            {pending.quote}
          </p>
          <textarea
            autoFocus
            data-testid="plan-comment-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder={t("commentPlaceholder")}
            // 16px on phones: iOS zooms the page into any smaller input.
            className="w-full resize-none rounded border bg-background px-2 py-1.5 text-base outline-none focus-visible:ring-1 focus-visible:ring-ring sm:text-xs"
            rows={3}
          />
          <div className="flex items-center gap-2 pt-2">
            <Button
              size="sm"
              data-testid="plan-comment-submit"
              className="h-7 rounded-full text-xs"
              disabled={!draft.trim()}
              onClick={submit}
            >
              <MessageSquarePlusIcon />
              {t("comment")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-full text-xs"
              onClick={() => setPending(null)}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommentBubble({
  comment,
  outdated,
  onRemove,
}: {
  comment: PlanComment;
  outdated?: boolean;
  onRemove?: (id: string) => void;
}) {
  const t = useTranslations("Chat.Artifact");
  return (
    <div
      data-testid="plan-comment"
      className={cn(
        "group/comment flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs",
        // Entry is a 4px slide plus a fade -- enough to say "this appeared
        // here", short enough not to be noticed on the tenth comment.
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-150",
        outdated && "opacity-60 border-dashed",
      )}
    >
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[11px] text-muted-foreground line-clamp-1 italic",
            outdated && "line-through",
          )}
        >
          {comment.quote}
        </p>
        <p className="whitespace-pre-wrap break-words">{comment.note}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(comment.id)}
          aria-label={t("removeComment")}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/comment:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}
