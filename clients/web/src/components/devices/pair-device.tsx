"use client";

import {
  type DeviceAuthorization,
  guessPlatform,
  parsePairingInput,
  pollDeviceToken,
  serverAddressAllowed,
  startDeviceAuthorization,
} from "@/lib/backend/devices-api";
import {
  connectToRemote,
  disconnectRemote,
  getRemoteOrigin,
  hasLocalBackend,
  setSessionToken,
} from "@/lib/backend/config";
import { VrndaLogo } from "@/components/layouts/vrnda-logo";
import { ExternalLink, Loader2, Monitor, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { Input } from "ui/input";
import { Label } from "ui/label";

/** The page's own origin, when another device could have opened it (the QR
 * code in Settings → Devices, served by the phone-access listener or a cloud
 * server). */
function pageServer(): string {
  if (typeof window === "undefined" || hasLocalBackend()) return "";
  const { protocol, origin } = window.location;
  return protocol === "http:" || protocol === "https:" ? origin : "";
}

type Phase =
  | { kind: "form" }
  | { kind: "waiting"; server: string; auth: DeviceAuthorization; until: number }
  | { kind: "denied" }
  | { kind: "expired" };

/**
 * /pair — connect this app to an Amiro running somewhere else, the way the
 * GitHub CLI signs in: enter the server's address once, this device gets a
 * short code, and the owner approves it at <server>/device (any browser,
 * signed in) or in Settings → Devices on that computer. Used by a phone and by
 * the desktop app switching to a cloud-hosted server.
 */
export function PairDevice() {
  const t = useTranslations("Devices.Pair");
  const params = useSearchParams();
  const [server, setServer] = useState("");
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<ReturnType<typeof guessPlatform>>("web");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const desktopApp = hasLocalBackend();
    const kind = guessPlatform(navigator.userAgent, desktopApp);
    setDesktop(desktopApp);
    setPlatform(kind);
    setName(t(`defaultName.${kind}`));
    setRemote(getRemoteOrigin());
    setServer(params.get("server") ?? pageServer());
  }, [params, t]);

  // Poll for approval at the interval the server asked for (RFC 8628).
  const waiting = phase.kind === "waiting" ? phase : null;
  const interval = useRef(5);
  useEffect(() => {
    if (!waiting) return;
    interval.current = waiting.auth.interval;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() > waiting.until) {
        setPhase({ kind: "expired" });
        return;
      }
      try {
        const result = await pollDeviceToken(waiting.server, waiting.auth.deviceCode);
        if (stopped) return;
        if (typeof result !== "string") {
          if (waiting.server === pageServer()) {
            // This page came from that Amiro itself: it is already the backend.
            disconnectRemote();
            setSessionToken(result.token);
          } else {
            connectToRemote(waiting.server, result.token);
          }
          // A full load, so every cached request starts again against it.
          window.location.assign("/");
          return;
        }
        if (result === "access_denied") return setPhase({ kind: "denied" });
        if (result === "expired_token") return setPhase({ kind: "expired" });
        if (result === "slow_down") interval.current += 5;
      } catch {
        // Offline for a moment: keep waiting until the code expires.
      }
      timer = window.setTimeout(tick, interval.current * 1000);
    };
    timer = window.setTimeout(tick, interval.current * 1000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(clock);
    };
  }, [waiting]);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const target = parsePairingInput(server).server;
    if (!target) {
      setError(t("badAddress"));
      return;
    }
    if (!serverAddressAllowed(target)) {
      setError(t("httpsNeeded"));
      return;
    }
    setBusy(true);
    try {
      const auth = await startDeviceAuthorization(target, { name: name.trim(), platform });
      setServer(target);
      setPhase({
        kind: "waiting",
        server: target,
        auth,
        until: Date.now() + auth.expiresIn * 1000,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message === "unreachable" ? t("unreachable") : message);
    } finally {
      setBusy(false);
    }
  };

  const switchBack = () => {
    disconnectRemote();
    window.location.assign("/");
  };

  const left = waiting ? Math.max(0, Math.floor((waiting.until - now) / 1000)) : 0;

  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-background p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <Card className="w-full max-w-md" data-testid="pair-card">
        <CardHeader className="items-center text-center">
          <VrndaLogo className="mb-2 size-8" />
          <CardTitle>
            <h1 className="text-2xl font-semibold">{t("title")}</h1>
          </CardTitle>
          <CardDescription>
            {waiting ? t("waitingDescription") : t("description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {waiting ? (
            <div className="flex flex-col items-center gap-4 text-center" data-testid="pair-waiting">
              <p className="text-xs text-muted-foreground">{t("yourCode")}</p>
              <p
                className="font-mono text-4xl font-semibold tracking-widest"
                data-testid="pair-user-code"
              >
                {waiting.auth.userCode}
              </p>
              <Button asChild className="w-full" data-testid="pair-open-approval">
                <a
                  href={`${waiting.server}${waiting.auth.verificationPathComplete}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-4" />
                  {t("openApproval")}
                </a>
              </Button>
              <p className="text-sm text-muted-foreground">
                {t("approveAt", { address: `${waiting.server}/device` })}
              </p>
              <p className="text-sm text-muted-foreground">{t("approveOnComputer")}</p>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {t("waiting", {
                  time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`,
                })}
              </p>
              <Button
                variant="ghost"
                onClick={() => setPhase({ kind: "form" })}
                data-testid="pair-cancel"
              >
                {t("cancel")}
              </Button>
            </div>
          ) : (
            <form className="flex flex-col gap-5" onSubmit={start}>
              {phase.kind === "denied" && (
                <p role="alert" className="text-sm text-destructive" data-testid="pair-denied">
                  {t("denied")}
                </p>
              )}
              {phase.kind === "expired" && (
                <p role="alert" className="text-sm text-destructive" data-testid="pair-expired">
                  {t("expired")}
                </p>
              )}
              <div className="grid gap-2">
                <Label htmlFor="pair-server">{t("serverLabel")}</Label>
                <Input
                  id="pair-server"
                  data-testid="pair-server-input"
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  placeholder="https://amiro.example.com"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  disabled={busy}
                />
                <p className="text-xs text-muted-foreground">{t("serverHint")}</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pair-name">{t("nameLabel")}</Label>
                <Input
                  id="pair-name"
                  data-testid="pair-name-input"
                  value={name}
                  maxLength={64}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive" data-testid="pair-error">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy} data-testid="pair-submit">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Smartphone className="size-4" />}
                {t("submit")}
              </Button>
              {remote && desktop && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={switchBack}
                  data-testid="pair-switch-back"
                >
                  <Monitor className="size-4" />
                  {t("switchBack")}
                </Button>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
