"use client";

import {
  AGENT_PROMPT_KEY,
  fetchAgentPrompt,
} from "@/lib/backend/agent-prompt-api";
import { useAgentScope } from "@/lib/backend/agent-scope";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useState } from "react";
import useSWR from "swr";
import { Button } from "ui/button";
import { Skeleton } from "ui/skeleton";
import { CardActions, ErrorLine, SetupCard, errorText } from "../card-ui";

/**
 * The agent's default prompt, as the runtime loads it: IDENTITY.md (name,
 * personality) and SOUL.md (how it works; the agent keeps it current).
 */
export function PromptCard({ onContinue }: { onContinue: () => void }) {
  const t = useTranslations("SetupChat");
  const scope = useAgentScope();
  const { data, error, isLoading } = useSWR(
    [AGENT_PROMPT_KEY, scope ?? "main"],
    () => fetchAgentPrompt(),
    { revalidateOnFocus: false },
  );
  const files = data?.files ?? [];
  const [active, setActive] = useState(0);
  const file = files[Math.min(active, files.length - 1)];

  return (
    <SetupCard testId="setup-prompt-card">
      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : files.length === 0 ? (
        <ErrorLine
          error={error ? errorText(error, t("promptError")) : t("promptEmpty")}
        />
      ) : (
        <>
          <div className="mb-2 flex gap-1" role="tablist">
            {files.map((f, i) => (
              <button
                key={f.name}
                type="button"
                role="tab"
                aria-selected={f === file}
                onClick={() => setActive(i)}
                className={cn(
                  "rounded-full px-3 py-1 font-mono text-xs transition-colors",
                  f === file
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
                data-testid={`setup-prompt-tab-${f.name}`}
              >
                {f.name}
              </button>
            ))}
          </div>
          <pre
            className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/60 p-3 font-mono text-xs leading-relaxed"
            data-testid="setup-prompt-text"
            tabIndex={0}
            aria-label={file?.name}
          >
            {file?.content}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("promptHint")}
          </p>
        </>
      )}
      <CardActions>
        <Button onClick={onContinue} data-testid="setup-prompt-continue">
          {t("looksGood")}
        </Button>
      </CardActions>
    </SetupCard>
  );
}
