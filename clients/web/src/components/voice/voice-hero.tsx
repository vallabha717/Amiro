"use client";

import { Loader2, Play, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useMessageReadAloudStore } from "@/lib/ai/speech/read-aloud-store";
import { cn } from "lib/utils";

const BARS = 28;
const HERO_MESSAGE_ID = "voice-hero-preview";

interface VoiceHeroProps {
  voiceName: string;
  providerName: string;
  model: string;
  provider: string;
  voiceId: string;
  speed: number;
}

/**
 * The page's face: who the assistant currently sounds like, with a waveform
 * that moves while the voice is speaking.
 */
export function VoiceHero({
  voiceName,
  providerName,
  model,
  provider,
  voiceId,
  speed,
}: VoiceHeroProps) {
  const t = useTranslations("VoiceSettings");
  const status = useMessageReadAloudStore((s) => s.status);
  const messageId = useMessageReadAloudStore((s) => s.messageId);
  const active = messageId === HERO_MESSAGE_ID && status !== "idle";
  const playing = active && status === "playing";

  function toggle() {
    const store = useMessageReadAloudStore.getState();
    if (active) {
      store.stop();
      return;
    }
    void store.playMessage({
      messageId: HERO_MESSAGE_ID,
      text: t("heroSample", { name: voiceName }),
      provider,
      model,
      voiceId,
      speed,
    });
  }

  return (
    <section
      data-testid="voice-hero"
      aria-label={t("heroLabel")}
      className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-6"
    >
      <style>{`@keyframes amiro-wave{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}`}</style>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">
            {t("heroEyebrow")}
          </p>
          <h2
            data-testid="voice-hero-name"
            className="mt-1 truncate text-3xl font-bold tracking-tight text-foreground"
          >
            {voiceName}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {providerName}
            {model ? ` · ${model}` : ""} · {speed.toFixed(2)}x
          </p>
          <Button
            size="sm"
            className="mt-4 gap-1.5"
            onClick={toggle}
            data-testid="voice-hero-play"
            aria-label={active ? t("heroStop") : t("heroPlay")}
          >
            {active && !playing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : active ? (
              <Square className="size-3.5 fill-current" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            {active ? t("heroStop") : t("heroPlay")}
          </Button>
        </div>

        <div
          aria-hidden
          className="flex h-20 items-center gap-[3px] sm:w-64"
        >
          {Array.from({ length: BARS }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-full w-full origin-center rounded-full",
                playing ? "bg-primary" : "bg-primary/30",
              )}
              style={{
                transform: playing ? undefined : `scaleY(${0.2 + ((i * 37) % 10) / 14})`,
                animation: playing
                  ? `amiro-wave ${0.7 + ((i * 13) % 6) / 10}s ease-in-out ${(i % 7) * 0.08}s infinite`
                  : undefined,
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
