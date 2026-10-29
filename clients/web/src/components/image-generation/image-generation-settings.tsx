"use client";

import { useEffect, useState } from "react";
import { ImageIcon, Loader2, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "lib/utils";
import {
  type GeneratedImageArtifact,
  type ImageProviderSpec,
  generateImage,
  saveImageGenerationSettings,
  useArtifactImage,
  useImageGenerationSettings,
} from "@/lib/backend/image-generation-api";

/**
 * Admin → Image generation: which provider the agent draws with (9Router,
 * OpenAI, Gemini or any OpenAI-compatible API), its model, its address and
 * its key, plus a prompt to try it.
 */
export function ImageGenerationSettings() {
  const t = useTranslations("ImageGeneration");
  const { data, mutate, isLoading } = useImageGenerationSettings();
  const catalog = data?.catalog ?? [];
  const saved = data?.config ?? null;

  const [kind, setKind] = useState<ImageProviderSpec["kind"] | "">("");
  const [model, setModel] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  // Start from what is saved, once it has loaded.
  useEffect(() => {
    if (!data || kind) return;
    if (saved) {
      setKind(saved.provider);
      setModel(saved.model);
      setApiBase(saved.apiBase);
    }
  }, [data, saved, kind]);

  const spec = catalog.find((s) => s.kind === kind);
  const keyKept = !!saved && saved.provider === kind && saved.keySet;

  const pick = (next: ImageProviderSpec) => {
    setKind(next.kind);
    const same = saved?.provider === next.kind;
    setModel(same ? saved.model : next.defaultModel);
    setApiBase(same ? saved.apiBase : (next.defaultApiBase ?? ""));
    setApiKey("");
  };

  const save = async () => {
    if (!spec || saving) return;
    setSaving(true);
    try {
      const next = await saveImageGenerationSettings({
        provider: spec.kind,
        model: model.trim(),
        apiBase: apiBase.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setApiKey("");
      await mutate(next, { revalidate: false });
      toast.success(t("saved", { provider: spec.label }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-8 p-6" data-testid="image-generation-settings">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ImageIcon className="size-6 text-primary" />
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          <p className="text-sm" data-testid="image-generation-status">
            {saved
              ? t("activeWith", {
                  provider: catalog.find((s) => s.kind === saved.provider)?.label ?? saved.provider,
                  model: saved.model,
                })
              : t("notSetUp")}
          </p>
        </header>

        <section className="space-y-3">
          <Label>{t("provider")}</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {isLoading && <Loader2 className="size-4 animate-spin" />}
            {catalog.map((p) => (
              <button
                key={p.kind}
                type="button"
                onClick={() => pick(p)}
                data-testid={`image-provider-${p.kind}`}
                data-selected={kind === p.kind}
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors hover:bg-accent",
                  kind === p.kind && "border-primary bg-primary/5",
                )}
              >
                <p className="font-medium">{p.label}</p>
                <p className="text-xs text-muted-foreground">{t(`about.${p.kind}`)}</p>
              </button>
            ))}
          </div>
        </section>

        {spec && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="image-model">{t("model")}</Label>
              <Input
                id="image-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={spec.defaultModel || t("modelPlaceholder")}
                data-testid="image-model-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="image-api-base">{t("apiBase")}</Label>
              <Input
                id="image-api-base"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder={spec.defaultApiBase || "https://router.example.com/v1"}
                data-testid="image-api-base-input"
              />
              {spec.needsApiBase && (
                <p className="text-xs text-muted-foreground">{t("apiBaseHint")}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="image-api-key" className="flex items-center gap-1">
                <Lock className="size-3" />
                {t("apiKey", { provider: spec.label })}
              </Label>
              <Input
                id="image-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keyKept ? t("keyKept", { hint: saved?.keyHint ?? "" }) : t("keyPlaceholder")}
                data-testid="image-api-key-input"
              />
              <a
                href={spec.docs}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                {t("getKey", { provider: spec.label })}
              </a>
            </div>
            <Button
              type="submit"
              disabled={saving || (!apiKey.trim() && !keyKept)}
              data-testid="image-generation-save"
            >
              {saving ? t("saving") : t("save")}
            </Button>
          </form>
        )}

        {saved && <TryIt />}
      </div>
    </ScrollArea>
  );
}

function TryIt() {
  const t = useTranslations("ImageGeneration");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GeneratedImageArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const src = useArtifactImage(result?.id);

  const run = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await generateImage(prompt.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("tryError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 border-t pt-6">
      <h2 className="text-lg font-semibold">{t("tryTitle")}</h2>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("tryPlaceholder")}
          data-testid="image-try-input"
        />
        <Button type="submit" disabled={busy || !prompt.trim()} data-testid="image-try-button">
          {busy ? <Loader2 className="size-4 animate-spin" /> : t("tryButton")}
        </Button>
      </form>
      {busy && <p className="text-xs text-muted-foreground">{t("tryWaiting")}</p>}
      {error && (
        <p className="text-sm text-destructive" data-testid="image-try-error">
          {error}
        </p>
      )}
      {result && (
        <figure className="space-y-1" data-testid="image-try-result">
          {src ? (
            <img src={src} alt={result.title} className="max-h-96 rounded-xl border" />
          ) : (
            <Loader2 className="size-4 animate-spin" />
          )}
          <figcaption className="text-xs text-muted-foreground">
            {t("trySaved", { model: result.model })}
          </figcaption>
        </figure>
      )}
    </section>
  );
}
