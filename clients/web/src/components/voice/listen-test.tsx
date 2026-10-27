"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { transcribeSpeech } from "@/lib/backend/voice-api";

const RECORD_MS = 5000;

type Phase = "idle" | "recording" | "transcribing";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

interface ListenTestProps {
  provider: string;
  model: string;
  language: string;
  keyless: boolean;
}

/** "Try it": record a few seconds and show what the listening engine heard. */
export function ListenTest({
  provider,
  model,
  language,
  keyless,
}: ListenTestProps) {
  const t = useTranslations("VoiceSettings");
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(
    () => () => streamRef.current?.getTracks().forEach((track) => track.stop()),
    [],
  );

  async function record() {
    setHeard(null);
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(t("micDenied"));
      return;
    }
    streamRef.current = stream;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      setPhase("transcribing");
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const res = await transcribeSpeech({
          audio: await blobToBase64(blob),
          mimeType: blob.type || "audio/webm",
          provider,
          model,
          language: language === "multi" ? undefined : language,
        });
        setHeard(res.text.trim() || t("heardNothing"));
      } catch (e) {
        setError(e instanceof Error ? e.message : t("listenFailed"));
      } finally {
        setPhase("idle");
      }
    };
    recorder.start();
    setPhase("recording");
    setTimeout(() => recorder.state !== "inactive" && recorder.stop(), RECORD_MS);
  }

  if (keyless) {
    return <p className="text-xs text-muted-foreground">{t("listenBrowser")}</p>;
  }

  return (
    <div
      className="space-y-2 rounded-lg border border-dashed border-border/70 p-3"
      data-testid="voice-listen-test"
    >
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={record}
          disabled={phase !== "idle"}
          data-testid="voice-listen-start"
          className="gap-1.5"
        >
          {phase === "idle" ? (
            <Mic className="size-3.5" aria-hidden />
          ) : (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          )}
          {phase === "recording"
            ? t("listening")
            : phase === "transcribing"
              ? t("transcribing")
              : t("listenTry")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("listenHint")}</p>
      </div>
      {heard ? (
        <p
          data-testid="voice-listen-result"
          className="rounded-md bg-muted/60 px-3 py-2 text-sm text-foreground"
        >
          <span className="mr-1.5 text-xs text-muted-foreground">
            {t("heard")}
          </span>
          {heard}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
