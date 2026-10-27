"use client";

import type { TeamAgent } from "@/lib/backend/agents-api";
import { cn } from "@/lib/utils";
import { SendHorizontalIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Button } from "ui/button";
import { Textarea } from "ui/textarea";
import { AgentAvatar } from "./agent-avatar";
import { insertMention, matchAgents, mentionQuery } from "./team-room-mentions";

export interface TeamRoomComposerHandle {
  /** Adds `@name` at the caret and focuses the box. */
  mention: (name: string) => void;
}

/** The room's message box, with @mention suggestions while typing `@`. */
export const TeamRoomComposer = forwardRef<
  TeamRoomComposerHandle,
  { agents: TeamAgent[]; onSend: (text: string) => Promise<boolean> }
>(function TeamRoomComposer({ agents, onSend }, ref) {
  const t = useTranslations("TeamRoom");
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);

  const query = mentionQuery(text, caret);
  const suggestions =
    query === null ? [] : matchAgents(agents, query).slice(0, 6);

  const apply = (next: { text: string; caret: number }) => {
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  useImperativeHandle(ref, () => ({
    mention: (name) => apply(insertMention(text, caret, name)),
  }));

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    const ok = await onSend(value);
    setSending(false);
    if (ok) apply({ text: "", caret: 0 });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        apply(
          insertMention(
            text,
            caret,
            suggestions[active]?.name ?? suggestions[0].name,
          ),
        );
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="relative border-t p-3">
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label={t("mentionList")}
          data-testid="team-room-mention-list"
          className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-xl border bg-popover p-1 shadow-panel"
        >
          {suggestions.map((agent, i) => (
            <li key={agent.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                data-testid={`team-room-mention-${agent.id}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  apply(insertMention(text, caret, agent.name));
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                  i === active ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <AgentAvatar agent={agent} size={22} />
                <span className="truncate">{agent.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={box}
          value={text}
          rows={2}
          maxLength={4000}
          aria-label={t("inputLabel")}
          placeholder={t("placeholder")}
          data-testid="team-room-input"
          className="min-h-[44px] resize-none"
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setActive(0);
          }}
          onSelect={(event) =>
            setCaret(event.currentTarget.selectionStart ?? 0)
          }
          onKeyDown={onKeyDown}
        />
        <Button
          type="button"
          size="icon"
          onClick={() => void send()}
          disabled={sending || !text.trim()}
          aria-label={t("send")}
          data-testid="team-room-send"
        >
          <SendHorizontalIcon className="size-4" />
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{t("hint")}</p>
    </div>
  );
});
