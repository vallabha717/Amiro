"use client";

import { Loader2, SquareTerminal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import { cn } from "lib/utils";

export interface CommandResult {
  command: string;
  status: "running" | "done" | "error";
  /** The runtime's own rendering, or why it failed. */
  text: string;
}

/**
 * What a `/` command answered, shown above the composer. The command ran in
 * the runtime (jcode's own `/context`, `/compact`, …); nothing was sent to
 * the model and nothing is added to the conversation.
 */
export function CommandResultPanel({ result, onClose }: { result: CommandResult; onClose: () => void }) {
  const t = useTranslations("Chat.Commands");
  return (
    <div data-testid="command-result" data-status={result.status}
      className={cn(
        "mx-1 mb-2 overflow-hidden rounded-xl border bg-muted/40",
        result.status === "error" && "border-destructive/40 bg-destructive/5",
      )}>
      <div className="flex items-center gap-2 px-3 py-2">
        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-mono text-xs font-semibold">/{result.command}</span>
        <span className="truncate text-xs text-muted-foreground">
          {result.status === "running" ? t("running") : result.status === "error" ? t("failed") : t("ranInRuntime")}
        </span>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("close")}
          data-testid="command-result-close" className="ml-auto size-6">
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      {result.status === "running" ? (
        <div className="flex items-center gap-2 px-3 pb-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t("running")}
        </div>
      ) : (
        <pre data-testid="command-result-text"
          className={cn(
            "max-h-64 overflow-auto px-3 pb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap",
            result.status === "error" ? "text-destructive" : "text-foreground",
          )}>
          {result.text.trim() || t("noOutput")}
        </pre>
      )}
    </div>
  );
}
