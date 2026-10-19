"use client";

import {
  type CatalogProvider,
  LoginPanel,
  isConfigured,
  loadCatalogProviders,
} from "@/components/chat/login-panel";
import { apiJson } from "@/lib/backend/client";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { mutate } from "swr";
import {
  Actions,
  ConfigBadge,
  Eyebrow,
  PrimaryButton,
  QuietButton,
  StepTitle,
  inputClass,
} from "./ui";

/** The common single-key providers, in the order most people want them. */
const FEATURED = [
  {
    id: "anthropic-api",
    name: "Anthropic",
    blurb: "Claude models",
    keyUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-…",
  },
  {
    id: "openai-api",
    name: "OpenAI",
    blurb: "GPT models",
    keyUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-…",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    blurb: "Hundreds of models, one key",
    keyUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-…",
  },
  {
    id: "gemini-api",
    name: "Google Gemini",
    blurb: "Gemini models",
    keyUrl: "https://aistudio.google.com/apikey",
    placeholder: "AIza…",
  },
] as const;

export function ProviderStep({
  agentName,
  source,
  onConnected,
  onDone,
  onSkip,
}: {
  agentName: string;
  source: string | null;
  onConnected: () => void;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const reload = useCallback(async () => {
    setCatalog(await loadCatalogProviders());
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const connectedIds = new Set(
    (catalog ?? []).filter(isConfigured).map((p) => p.id),
  );
  const anyConnected = connectedIds.size > 0;
  const known = new Set((catalog ?? []).map((p) => p.id));
  const featured = FEATURED.filter((p) => !catalog?.length || known.has(p.id));

  const connect = async (id: string) => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/providers/${encodeURIComponent(id)}/api-key`, {
        method: "POST",
        body: JSON.stringify({ apiKey: key.trim() }),
      });
      setKey("");
      setOpen(null);
      onConnected();
      await Promise.all([reload(), mutate("/api/chat/models")]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That key didn't work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Eyebrow>Brain</Eyebrow>
      <StepTitle
        sub={`${agentName.trim() || "Your agent"} thinks with a model from an AI provider. Paste an API key; it's stored encrypted on the machine running Amiro.`}
      >
        Choose a brain.
      </StepTitle>
      <ConfigBadge source={source} />

      <ul className="divide-y divide-foreground/[0.07] overflow-hidden rounded-2xl border border-foreground/10 bg-background/60 backdrop-blur">
        {featured.map((p) => {
          const connected = connectedIds.has(p.id);
          const expanded = open === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(expanded ? null : p.id);
                  setKey("");
                  setError(null);
                }}
                aria-expanded={expanded}
                className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:bg-foreground/[0.04]"
                data-testid={`onboarding-provider-${p.id}`}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground/[0.06] font-brand text-base">
                  {p.name[0]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium">
                    {p.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.blurb}
                  </span>
                </span>
                {connected ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <Check className="size-3.5" strokeWidth={3} /> Connected
                  </span>
                ) : (
                  <ChevronDown
                    className={cn(
                      "size-4 text-muted-foreground transition-transform",
                      expanded && "rotate-180",
                    )}
                  />
                )}
              </button>
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden"
                  >
                    <form
                      className="flex flex-col gap-2 px-4 pb-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        connect(p.id);
                      }}
                    >
                      <div className="flex gap-2">
                        <input
                          type="password"
                          autoFocus
                          autoComplete="off"
                          spellCheck={false}
                          className={cn(inputClass, "h-11 font-mono text-sm")}
                          placeholder={
                            connected ? "Replace the saved key" : p.placeholder
                          }
                          value={key}
                          onChange={(e) => setKey(e.target.value)}
                          aria-label={`${p.name} API key`}
                          data-testid="onboarding-provider-key"
                        />
                        <PrimaryButton
                          type="submit"
                          className="h-11 min-w-24 px-5"
                          disabled={!key.trim()}
                          loading={busy}
                          data-testid="onboarding-provider-connect"
                        >
                          Connect
                        </PrimaryButton>
                      </div>
                      <a
                        href={p.keyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex w-fit items-center gap-0.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        Get a {p.name} key <ArrowUpRight className="size-3" />
                      </a>
                      {error && (
                        <p role="alert" className="text-sm text-destructive">
                          {error}
                        </p>
                      )}
                    </form>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={() => setMore((v) => !v)}
        className="mt-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={more}
        data-testid="onboarding-provider-more"
      >
        <ChevronDown
          className={cn("size-4 transition-transform", more && "rotate-180")}
        />
        Subscriptions, local models and more providers
      </button>
      {more && (
        <div className="mt-3">
          <LoginPanel
            onClose={() => {
              setMore(false);
              reload();
            }}
          />
        </div>
      )}

      <Actions>
        <PrimaryButton
          onClick={onDone}
          disabled={!anyConnected}
          data-testid="onboarding-provider-continue"
        >
          Continue
        </PrimaryButton>
        <QuietButton onClick={onSkip} data-testid="onboarding-provider-skip">
          Skip for now
        </QuietButton>
      </Actions>
    </div>
  );
}
