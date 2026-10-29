"use client";

import {
  ArrowRightIcon,
  CircleCheckIcon,
  FileIcon,
  FlaskConicalIcon,
  ListChecksIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Markdown } from "../markdown";
import type {
  PlanArtifact,
  TodoArtifact,
  WalkthroughArtifact,
} from "./use-artifacts";

/**
 * The end-of-work summary: what was done, where to look, how to check it.
 *
 * It closes the Plan → Tasks → Walkthrough arc, so it opens by tying back to
 * the other two -- the plan it delivered and the tasks that got ticked --
 * before the agent's own account. A reader who only looks at the header
 * should still know whether the job is finished and how big it was.
 *
 * The order of the changes is the content. A diff already tells you which
 * files changed; it cannot tell you which one to open first, and after a
 * forty-step turn that is the only question a reviewer actually has. So the
 * list is numbered and the numbers are the model's claim about where to start.
 */
export function WalkthroughView({
  walkthrough,
  plan,
  todos,
}: {
  walkthrough?: WalkthroughArtifact;
  plan?: PlanArtifact;
  todos?: TodoArtifact;
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

  const total = todos?.items.length ?? 0;
  const doneTasks = todos?.items.filter((i) => i.status === "done") ?? [];

  return (
    <div className="flex h-full flex-col" data-testid="walkthrough-view">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
        <header
          data-testid="walkthrough-hero"
          className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-4"
        >
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <CircleCheckIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold leading-tight">
                {walkthrough.streaming
                  ? t("walkthroughWriting")
                  : t("walkthroughDone")}
              </h2>
              {plan?.title && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {t("walkthroughFor", { title: plan.title })}
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {total > 0 && (
              <Stat icon={<ListChecksIcon className="size-3" />}>
                {t("tasksProgress", { done: doneTasks.length, total })}
              </Stat>
            )}
            {walkthrough.changes.length > 0 && (
              <Stat icon={<FileIcon className="size-3" />}>
                {t("statChanges", { count: walkthrough.changes.length })}
              </Stat>
            )}
            {walkthrough.followUps.length > 0 && (
              <Stat icon={<ArrowRightIcon className="size-3" />}>
                {t("statFollowUps", { count: walkthrough.followUps.length })}
              </Stat>
            )}
          </div>
        </header>

        <Section title={t("whatHappened")}>
          <Markdown
            isStreaming={
              walkthrough.streaming && walkthrough.changes.length === 0
            }
          >
            {walkthrough.summary}
          </Markdown>
        </Section>

        {walkthrough.changes.length > 0 && (
          <Section title={t("readingOrder")}>
            <ol className="relative flex flex-col gap-3">
              {/* The rail ties the steps into one path, read top to bottom. */}
              <span
                aria-hidden
                className="absolute top-3 bottom-3 left-[11px] w-px bg-border"
              />
              {walkthrough.changes.map((change, i) => (
                <li
                  key={`${change.path}-${i}`}
                  data-testid="walkthrough-change"
                  className="relative flex items-start gap-3"
                >
                  <span className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-[11px] font-semibold text-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2">
                    <p className="flex items-center gap-1.5 font-mono text-xs">
                      <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{change.path}</span>
                    </p>
                    {change.why && (
                      <p className="mt-1 text-xs leading-snug text-muted-foreground">
                        {change.why}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        )}

        {walkthrough.unmentioned.length > 0 && (
          <section className="mt-5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
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
          <section className="mt-5 rounded-lg border bg-muted/40 px-3 py-2.5">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <FlaskConicalIcon className="size-3.5" />
              {t("howToVerify")}
            </h3>
            <Markdown>{walkthrough.testing}</Markdown>
          </section>
        )}

        {doneTasks.length > 0 && (
          <Section title={t("tasksCompleted")}>
            <ul className="flex flex-col gap-1">
              {doneTasks.map((item, i) => (
                <li
                  key={`${i}-${item.content}`}
                  className="flex items-start gap-2 text-xs leading-snug"
                >
                  <CircleCheckIcon className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="min-w-0">{item.content}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {walkthrough.followUps.length > 0 && (
          <Section title={t("followUps")}>
            <ul className="flex flex-col gap-1.5">
              {walkthrough.followUps.map((item, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-xs leading-snug"
                >
                  <ArrowRightIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">{item}</span>
                </li>
              ))}
            </ul>
          </Section>
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Stat({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
      {icon}
      {children}
    </span>
  );
}
