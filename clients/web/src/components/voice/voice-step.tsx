"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Play, Search, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessageReadAloudStore } from "@/lib/ai/speech/read-aloud-store";
import {
  fetchProviderVoices,
  type VoiceOptionItem,
  type VoiceProviderCatalogEntry,
} from "@/lib/backend/voice-api";
import { cn } from "lib/utils";

interface VoiceStepProps {
  entry: VoiceProviderCatalogEntry | undefined;
  model: string;
  voiceId: string;
  speed: number;
  onSelect: (voice: VoiceOptionItem) => void;
  onSpeedCommit: (speed: number) => void;
}

/**
 * Step 3: audition the voices of the connected engine and keep one. Voices come
 * from the engine itself (the vault key is used server side) so custom and
 * cloned voices show up too.
 */
export function VoiceStep({
  entry,
  model,
  voiceId,
  speed: savedSpeed,
  onSelect,
  onSpeedCommit,
}: VoiceStepProps) {
  const t = useTranslations("VoiceSettings");
  const [voices, setVoices] = useState<VoiceOptionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [speed, setSpeed] = useState(savedSpeed);
  const [sample, setSample] = useState(t("sampleText"));
  const status = useMessageReadAloudStore((s) => s.status);
  const playingId = useMessageReadAloudStore((s) => s.messageId);

  const providerId = entry?.id;
  const selectable = Boolean(entry?.supportsVoiceSelection);

  useEffect(() => setSpeed(savedSpeed), [savedSpeed]);

  useEffect(() => {
    if (!providerId || !selectable) {
      setVoices([]);
      return;
    }
    let live = true;
    setLoading(true);
    fetchProviderVoices({ provider: providerId })
      .then((list) => {
        if (live) setVoices(list);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [providerId, selectable]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.id.toLowerCase().includes(q) ||
        (v.category ?? "").toLowerCase().includes(q),
    );
  }, [voices, query]);

  function preview(id: string) {
    if (!providerId) return;
    const messageId = `voice-preview-${id}`;
    const store = useMessageReadAloudStore.getState();
    if (playingId === messageId && status !== "idle") {
      store.stop();
      return;
    }
    void store.playMessage({
      messageId,
      text: sample.trim() || t("sampleText"),
      provider: providerId,
      model,
      voiceId: id,
      speed,
    });
  }

  const isPlaying = (id: string) =>
    playingId === `voice-preview-${id}` && status !== "idle";

  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border/70 bg-card/50 p-4"
      data-testid="voice-picker"
    >
      <div className="space-y-1.5">
        <Label htmlFor="voice-sample" className="text-xs font-semibold">
          {t("sampleLabel")}
        </Label>
        <Input
          id="voice-sample"
          data-testid="voice-sample"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          className="h-9 text-xs"
        />
      </div>

      {selectable ? (
        <>
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchVoices")}
              aria-label={t("searchVoices")}
              className="h-9 pl-9 text-xs"
            />
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("loadingVoices")}
            </div>
          ) : shown.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t("noVoices")}
            </p>
          ) : (
            <ul className="grid max-h-[360px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {shown.map((v) => {
                const selected = v.id === voiceId;
                const playing = isPlaying(v.id);
                return (
                  <li
                    key={v.id}
                    data-testid={`voice-option-${v.id}`}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border p-2.5 transition-colors",
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border/70 bg-background hover:border-foreground/30",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => preview(v.id)}
                      aria-label={
                        playing
                          ? t("stopPreview", { name: v.name })
                          : t("playPreview", { name: v.name })
                      }
                      data-testid={`voice-preview-${v.id}`}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {playing && status === "loading" ? (
                        <Loader2
                          className="size-3.5 animate-spin"
                          aria-hidden
                        />
                      ) : playing ? (
                        <Square className="size-3.5 fill-current" aria-hidden />
                      ) : (
                        <Play className="size-3.5" aria-hidden />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {v.name}
                      </div>
                      {v.category ? (
                        <div className="truncate text-[11px] text-muted-foreground">
                          {v.category}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => onSelect(v)}
                      aria-pressed={selected}
                      data-testid={`voice-use-${v.id}`}
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "bg-primary text-primary-foreground"
                          : "border border-border/70 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {selected ? (
                        <Check className="size-3" aria-hidden />
                      ) : null}
                      {selected ? t("selected") : t("useVoice")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => preview("default")}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-3 py-1.5 text-xs font-medium hover:bg-accent"
            data-testid="voice-preview-default"
          >
            {isPlaying("default") ? (
              <Square className="size-3.5 fill-current" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            {t("playBrowserVoice")}
          </button>
          <p className="text-xs text-muted-foreground">{t("browserVoice")}</p>
        </div>
      )}

      <div className="space-y-1.5 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="voice-speed" className="text-xs font-semibold">
            {t("speed")}
          </Label>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {speed.toFixed(2)}x
          </span>
        </div>
        <input
          id="voice-speed"
          type="range"
          min="0.5"
          max="2"
          step="0.05"
          value={speed}
          onChange={(e) => setSpeed(Number.parseFloat(e.target.value))}
          onPointerUp={() => onSpeedCommit(speed)}
          onKeyUp={() => onSpeedCommit(speed)}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-secondary accent-primary"
        />
      </div>
    </div>
  );
}
