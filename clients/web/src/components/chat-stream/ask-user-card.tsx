"use client";

import {
  type AskUserAnswer,
  type AskUserRequest,
  formatAskUserReply,
  isAnswered,
} from "lib/chat-ux/ask-user";
import { cn } from "lib/utils";
import { CheckIcon, MessageCircleQuestionIcon, PencilLineIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { Button } from "ui/button";

/**
 * The card the agent opens with `ui_ask_user`: one question at a time, each
 * a short list of choices plus a free-text "Other". Sending posts the
 * answers as the user's next message, which is what the agent waits for.
 *
 * `settled` is true once the conversation has moved past this turn (the
 * user answered, here or by typing): the card then shows what was asked,
 * read-only, so a reloaded thread never offers a stale question.
 */
export function AskUserCard({
  request,
  settled,
  readonly,
  onSubmit,
}: {
  request: AskUserRequest;
  settled: boolean;
  readonly?: boolean;
  onSubmit?: (text: string) => void;
}) {
  const t = useTranslations("ChatStream.AskUser");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, AskUserAnswer>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [sent, setSent] = useState(false);
  const otherRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  const total = request.questions.length;
  const q = request.questions[Math.min(step, total - 1)];
  const answer = answers[q.id] ?? { selected: [] };
  const locked = settled || sent || readonly || !onSubmit;
  const isLast = step >= total - 1;
  const allAnswered = request.questions.every((x) => isAnswered(answers[x.id]));

  const update = (id: string, next: AskUserAnswer) =>
    setAnswers((prev) => ({ ...prev, [id]: next }));

  const toggle = (label: string) => {
    if (locked) return;
    if (q.multiSelect) {
      const has = answer.selected.includes(label);
      update(q.id, {
        ...answer,
        selected: has
          ? answer.selected.filter((l) => l !== label)
          : [...answer.selected, label],
      });
    } else {
      // A single-choice pick replaces "Other" too, so only one answer stands.
      update(q.id, { selected: [label], other: "" });
      setOtherOpen((prev) => ({ ...prev, [q.id]: false }));
    }
  };

  const openOther = () => {
    if (locked) return;
    setOtherOpen((prev) => ({ ...prev, [q.id]: true }));
    if (!q.multiSelect) update(q.id, { selected: [], other: answer.other ?? "" });
    requestAnimationFrame(() => otherRef.current?.focus());
  };

  const send = () => {
    if (locked || !allAnswered) return;
    setSent(true);
    onSubmit?.(formatAskUserReply(request, answers));
  };

  const advance = () => {
    if (!isAnswered(answer)) return;
    if (isLast) send();
    else setStep((s) => s + 1);
  };

  // Number keys pick an option, Enter moves on -- the card answers without
  // the mouse. Typing inside the "Other" field is left alone.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (locked) return;
    const inField = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      advance();
      return;
    }
    if (inField) return;
    const n = Number.parseInt(e.key, 10);
    if (n >= 1 && n <= q.options.length) {
      e.preventDefault();
      toggle(q.options[n - 1].label);
    } else if (n === q.options.length + 1) {
      e.preventDefault();
      openOther();
    }
  };

  if (settled || sent) {
    return (
      <div
        data-testid="ask-user-card"
        data-state="answered"
        className="rounded-xl border bg-card px-3.5 py-3 text-sm"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {sent ? (
            <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <MessageCircleQuestionIcon className="size-3.5" />
          )}
          {/* Only this browser knows the picks it sent; a reloaded or
              typed-past card just says the agent asked. */}
          <span>{sent ? t("answered") : t("askedEarlier")}</span>
        </div>
        <ul className="mt-2 flex flex-col gap-1.5">
          {request.questions.map((x) => {
            const a = answers[x.id];
            const picks = [...(a?.selected ?? []), a?.other?.trim()].filter(Boolean);
            return (
              <li key={x.id} className="flex flex-col">
                <span className="text-muted-foreground">{x.question}</span>
                {picks.length ? (
                  <span className="font-medium">{picks.join(", ")}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  const otherSelected = Boolean(otherOpen[q.id]);
  const groupLabelId = `${baseId}-${q.id}-label`;

  return (
    <div
      data-testid="ask-user-card"
      data-state="open"
      onKeyDown={onKeyDown}
      className="ask-user-in rounded-xl border bg-card shadow-xs"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <MessageCircleQuestionIcon className="size-4 shrink-0 text-primary" />
        {q.header ? (
          <span className="truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            {q.header}
          </span>
        ) : null}
        {total > 1 ? (
          <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {t("progress", { current: step + 1, total })}
            <span className="flex gap-1" aria-hidden>
              {request.questions.map((x, i) => (
                <span
                  key={x.id}
                  className={cn(
                    "size-1.5 rounded-full transition-colors",
                    i === step
                      ? "bg-primary"
                      : isAnswered(answers[x.id])
                        ? "bg-primary/40"
                        : "bg-muted-foreground/25",
                  )}
                />
              ))}
            </span>
          </span>
        ) : null}
      </div>

      <p id={groupLabelId} className="px-3.5 pt-2 text-[15px] font-medium leading-snug">
        {q.question}
      </p>
      {q.multiSelect ? (
        <p className="px-3.5 pt-0.5 text-xs text-muted-foreground">{t("pickAny")}</p>
      ) : null}

      <div
        role={q.multiSelect ? "group" : "radiogroup"}
        aria-labelledby={groupLabelId}
        className="flex flex-col gap-1.5 p-3"
      >
        {q.options.map((opt, i) => {
          const checked = answer.selected.includes(opt.label);
          return (
            <button
              key={opt.label}
              type="button"
              role={q.multiSelect ? "checkbox" : "radio"}
              aria-checked={checked}
              data-testid="ask-user-option"
              onClick={() => toggle(opt.label)}
              className={cn(
                "group/opt flex items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                checked
                  ? "border-primary/60 bg-primary/5"
                  : "hover:border-foreground/20 hover:bg-muted/40",
              )}
            >
              <kbd
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border font-sans text-[11px] tabular-nums transition-colors",
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "text-muted-foreground",
                )}
              >
                {checked ? <CheckIcon className="size-3" /> : i + 1}
              </kbd>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{opt.label}</span>
                {opt.description ? (
                  <span className="text-xs text-muted-foreground">{opt.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}

        <div
          className={cn(
            "flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
            otherSelected ? "border-primary/60 bg-primary/5" : "border-dashed",
          )}
        >
          <kbd className="flex size-5 shrink-0 items-center justify-center rounded border font-sans text-[11px] text-muted-foreground">
            {otherSelected ? <PencilLineIcon className="size-3" /> : q.options.length + 1}
          </kbd>
          {otherSelected ? (
            <input
              ref={otherRef}
              data-testid="ask-user-other-input"
              aria-label={t("otherLabel")}
              value={answer.other ?? ""}
              placeholder={t("otherPlaceholder")}
              onChange={(e) => update(q.id, { ...answer, other: e.target.value })}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          ) : (
            <button
              type="button"
              data-testid="ask-user-other"
              onClick={openOther}
              className="flex-1 text-left text-sm text-muted-foreground hover:text-foreground"
            >
              {t("other")}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t px-3.5 py-2">
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          {t("keyboardHint")}
        </span>
        <div className="ml-auto flex gap-2">
          {step > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="ask-user-back"
              onClick={() => setStep((s) => s - 1)}
            >
              {t("back")}
            </Button>
          ) : null}
          <Button
            size="sm"
            data-testid={isLast ? "ask-user-send" : "ask-user-next"}
            disabled={locked || !isAnswered(answer) || (isLast && !allAnswered)}
            onClick={advance}
          >
            {isLast ? t("send") : t("next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
