"use client";

import { FileIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Markdown } from "../markdown";
import type { WalkthroughArtifact } from "./use-artifacts";

/**
 * The end-of-turn summary: what changed, in reading order.
 *
 * The order is the content. A diff already tells you which files changed; it
 * cannot tell you which one to open first, and after a forty-step turn that
 * is the only question a reviewer actually has. So the list is numbered and
 * the numbers are the model's claim about where to start.
 */
export function WalkthroughView({
  walkthrough,
}: {
  walkthrough?: WalkthroughArtifact;
}) {
  const t = useTranslations("Chat.Artifact");

  if (!walkthrough) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-xs text-center text-xs text-muted-foreground">
          {t("noWalkthroughYet")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="walkthrough-view">
      <header className="shrink-0 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{t("walkthroughTitle")}</h2>
        {walkthrough.streaming && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="inline-block size-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
            {t("walkthroughWriting")}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
        <Markdown
          isStreaming={
            walkthrough.streaming && walkthrough.changes.length === 0
          }
        >
          {walkthrough.summary}
        </Markdown>

        {walkthrough.changes.length > 0 && (
          <section className="mt-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("readingOrder")}
            </h3>
            <ol className="flex flex-col gap-2">
              {walkthrough.changes.map((change, i) => (
                <li
                  key={`${change.path}-${i}`}
                  className="flex items-start gap-2.5 rounded-md border bg-card px-2.5 py-2"
                >
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 font-mono text-xs">
                      <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{change.path}</span>
                    </p>
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                      {change.why}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {walkthrough.unmentioned.length > 0 && (
          <section className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              <TriangleAlertIcon className="size-3.5 shrink-0" />
              {t("unmentionedTitle")}
            </p>
            {/* Checked against the turn's own successful edit calls, not
                against the model's account of itself. A walkthrough that
                omits a file is the one failure mode this artifact has: it
                reads as complete either way. */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("unmentionedHint")}
            </p>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {walkthrough.unmentioned.map((path) => (
                <li key={path} className="font-mono text-xs">
                  {path}
                </li>
              ))}
            </ul>
          </section>
        )}

        {walkthrough.testing && (
          <section className="mt-4">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("howToVerify")}
            </h3>
            <Markdown>{walkthrough.testing}</Markdown>
          </section>
        )}

        {walkthrough.followUps.length > 0 && (
          <section className="mt-4">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("followUps")}
            </h3>
            <ul className="flex flex-col gap-1">
              {walkthrough.followUps.map((item, i) => (
                <li key={i} className="text-xs leading-snug">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}

        {walkthrough.notice && (
          <p className="mt-4 text-[11px] text-amber-600 dark:text-amber-400">
            {walkthrough.notice}
          </p>
        )}
      </div>
    </div>
  );
}
