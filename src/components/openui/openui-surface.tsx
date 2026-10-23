"use client";

import { useCopy } from "@/hooks/use-copy";
import { OPENUI_PRESETS, amiroOpenUILibrary } from "@/lib/openui/amiro-library";
import { type ActionEvent, Renderer } from "@openuidev/react-lang";
import { cn } from "lib/utils";
import {
  CheckIcon,
  Code2Icon,
  CopyIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { Button } from "ui/button";

export interface OpenUISurfaceProps {
  /** OpenUI Lang program (`root = Stack([...])`) */
  code: string;
  /** Optional title displayed in the surface chrome */
  title?: string;
  /** Optional preset slug */
  preset?: string;
  /** Whether tokens are still streaming */
  isStreaming?: boolean;
  /** Handler when an interactive control or follow-up chip sends a prompt */
  onSendPrompt?: (prompt: string) => void;
  className?: string;
}

/**
 * Normalize an incoming OpenUI Lang snippet or preset reference so both complete
 * and streaming blocks render cleanly.
 */
export function resolveOpenUICode(raw: string, preset?: string): string {
  const trimmed = (raw ?? "").trim();
  if (
    preset &&
    preset in OPENUI_PRESETS &&
    (!trimmed || trimmed === preset)
  ) {
    return OPENUI_PRESETS[preset as keyof typeof OPENUI_PRESETS].code;
  }
  if (trimmed in OPENUI_PRESETS) {
    return OPENUI_PRESETS[trimmed as keyof typeof OPENUI_PRESETS].code;
  }
  return trimmed;
}

export function OpenUISurface({
  code,
  title,
  preset,
  isStreaming = false,
  onSendPrompt,
  className,
}: OpenUISurfaceProps) {
  const t = useTranslations("Chat.OpenUI");
  const { copied, copy } = useCopy();
  const [showSource, setShowSource] = useState(false);

  const resolvedCode = useMemo(
    () => resolveOpenUICode(code, preset),
    [code, preset],
  );

  const handleAction = useCallback(
    (event: ActionEvent) => {
      const prompt =
        (typeof event.params?.prompt === "string" && event.params.prompt) ||
        (typeof event.params?.message === "string" && event.params.message) ||
        event.humanFriendlyMessage ||
        "";
      const cleanPrompt = prompt.trim();
      if (!cleanPrompt) return;

      if (onSendPrompt) {
        onSendPrompt(cleanPrompt);
      } else if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("amiro:send-prompt", {
            detail: { prompt: cleanPrompt },
          }),
        );
      }
    },
    [onSendPrompt],
  );

  if (!resolvedCode) {
    return null;
  }

  return (
    <section
      data-testid="openui-surface"
      data-streaming={isStreaming ? "true" : "false"}
      aria-label={title || "OpenUI interactive surface"}
      className={cn(
        "my-3 w-full overflow-hidden rounded-2xl border border-border/80 bg-card text-card-foreground shadow-sm transition-all",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
            <SparklesIcon className="size-3" />
            {t("badge")}
          </span>
          {title ? (
            <span className="truncate text-xs font-medium text-muted-foreground">
              {title}
            </span>
          ) : null}
          {isStreaming ? (
            <span
              data-testid="openui-streaming-indicator"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            >
              <Loader2Icon className="size-3 animate-spin text-primary" />
              {t("streaming")}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="openui-toggle-source"
            aria-label={showSource ? t("hideSource") : t("viewSource")}
            onClick={() => setShowSource((v) => !v)}
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Code2Icon className="size-3.5" />
            <span>{showSource ? t("hideSource") : t("viewSource")}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="openui-copy-source"
            aria-label="Copy OpenUI code"
            onClick={() => copy(resolvedCode)}
            className="size-7 text-muted-foreground hover:text-foreground"
          >
            {copied ? (
              <CheckIcon className="size-3.5 text-emerald-500" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      {showSource ? (
        <pre
          data-testid="openui-source-code"
          className="max-h-56 overflow-auto border-b border-border/60 bg-muted/40 p-3.5 font-mono text-xs leading-relaxed text-muted-foreground"
        >
          {resolvedCode}
        </pre>
      ) : null}

      <div className="p-4 sm:p-5">
        <Renderer
          response={resolvedCode}
          library={amiroOpenUILibrary}
          isStreaming={isStreaming}
          onAction={handleAction}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Extraction helper for MCP tool calls (`ui_render_openui`)
// ---------------------------------------------------------------------------

export interface ExtractedOpenUIPayload {
  title?: string;
  preset?: string;
  code: string;
}

export function extractOpenUIPayload(
  input: any,
  output: any,
): ExtractedOpenUIPayload | null {
  const preset =
    typeof input?.preset === "string"
      ? input.preset
      : typeof output?.preset === "string"
        ? output.preset
        : undefined;
  const title =
    typeof input?.title === "string"
      ? input.title
      : typeof output?.title === "string"
        ? output.title
        : preset && preset in OPENUI_PRESETS
          ? OPENUI_PRESETS[preset as keyof typeof OPENUI_PRESETS].title
          : undefined;

  if (typeof input?.code === "string" && input.code.trim()) {
    return { title, preset, code: input.code.trim() };
  }
  if (typeof output?.code === "string" && output.code.trim()) {
    return { title, preset, code: output.code.trim() };
  }
  if (preset && preset in OPENUI_PRESETS) {
    return {
      title,
      preset,
      code: OPENUI_PRESETS[preset as keyof typeof OPENUI_PRESETS].code,
    };
  }

  // Inspect MCP text output blocks for ```openui ... ``` or ```json ... ```
  const texts: string[] = [];
  const collect = (val: unknown) => {
    if (typeof val === "string") {
      texts.push(val);
      return;
    }
    if (Array.isArray(val)) {
      val.forEach(collect);
      return;
    }
    if (val && typeof val === "object") {
      const r = val as Record<string, unknown>;
      if (typeof r.text === "string") texts.push(r.text);
      if (r.content !== undefined) collect(r.content);
    }
  };
  collect(output);

  for (const s of texts) {
    const openuiMatch = /```openui\s*\n([\s\S]*?)(?:```|$)/.exec(s);
    if (openuiMatch?.[1]?.trim()) {
      return { title, preset, code: openuiMatch[1].trim() };
    }
    const jsonMatch = /```json\s*\n([\s\S]*?)```/.exec(s);
    if (jsonMatch?.[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (typeof parsed?.code === "string" && parsed.code.trim()) {
          return {
            title: parsed.title ?? title,
            preset: parsed.preset ?? preset,
            code: parsed.code.trim(),
          };
        }
      } catch {
        // Ignore non-JSON
      }
    }
  }

  return null;
}
