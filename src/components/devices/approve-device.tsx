"use client";

import {
  answerRequest,
  type DeviceRequest,
  lookupRequest,
} from "@/lib/backend/devices-api";
import { useSession } from "@/lib/backend/session-context";
import { VrndaLogo } from "@/components/layouts/vrnda-logo";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
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
import { DeviceIcon } from "./device-icon";

/**
 * /device — approve a device that is asking to connect, like GitHub's
 * github.com/login/device. The device shows a code; the owner signs in here
 * from any browser, enters that code, checks what is asking, and approves or
 * denies it. A link from the device opens this page with `?code=` filled in.
 */
export function ApproveDevice() {
  const t = useTranslations("Devices.Approve");
  const format = useFormatter();
  const router = useRouter();
  const params = useSearchParams();
  const { data: session, isPending } = useSession();
  const [code, setCode] = useState("");
  const [request, setRequest] = useState<DeviceRequest | null>(null);
  const [answered, setAnswered] = useState<"approved" | "denied" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linkCode = params.get("code") ?? "";
  useEffect(() => setCode(linkCode.toUpperCase()), [linkCode]);

  // Sign in first, then come straight back here with the same code.
  useEffect(() => {
    if (isPending || session) return;
    const back = `/device${linkCode ? `?code=${encodeURIComponent(linkCode)}` : ""}`;
    router.replace(`/sign-in?next=${encodeURIComponent(back)}`);
  }, [isPending, session, linkCode, router]);

  const find = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim()) {
      setError(t("needCode"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setRequest(await lookupRequest(code.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const answer = async (approve: boolean) => {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      await answerRequest(request.id, approve);
      setAnswered(approve ? "approved" : "denied");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (isPending || !session) return null;
  const owner = session.user.role === "admin";

  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md" data-testid="device-approve">
        <CardHeader className="items-center text-center">
          <VrndaLogo className="mb-2 size-8" />
          <CardTitle>
            <h1 className="text-2xl font-semibold">{t("title")}</h1>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {!owner ? (
            <p role="alert" className="text-sm text-destructive">
              {t("ownerOnly")}
            </p>
          ) : answered ? (
            <div
              className="flex flex-col items-center gap-3 text-center"
              data-testid="device-approve-done"
            >
              {answered === "approved" ? (
                <Check className="size-10 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <X className="size-10 text-muted-foreground" />
              )}
              <p className="font-medium">
                {answered === "approved"
                  ? t("approved", { name: request?.name ?? "" })
                  : t("denied", { name: request?.name ?? "" })}
              </p>
              <p className="text-sm text-muted-foreground">{t("closeHint")}</p>
            </div>
          ) : request ? (
            <div className="flex flex-col gap-4" data-testid="device-approve-request">
              <div className="flex items-center gap-3 rounded-lg border p-3">
                <DeviceIcon platform={request.platform} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium" data-testid="device-approve-name">
                    {request.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`platform.${request.platform}`)}
                    {request.address ? ` · ${t("from", { address: request.address })}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("asked", {
                      when: format.relativeTime(new Date(request.createdAt), new Date()),
                    })}
                  </p>
                </div>
                <code className="font-mono text-sm font-semibold tracking-widest">
                  {request.userCode}
                </code>
              </div>
              <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                {t("warning")}
              </p>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={() => answer(true)}
                  disabled={busy}
                  data-testid="device-approve-yes"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  {t("approve")}
                </Button>
                <Button
                  className="flex-1"
                  variant="outline"
                  onClick={() => answer(false)}
                  disabled={busy}
                  data-testid="device-approve-no"
                >
                  <X className="size-4" />
                  {t("deny")}
                </Button>
              </div>
            </div>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={find}>
              <div className="grid gap-2">
                <Label htmlFor="device-code">{t("codeLabel")}</Label>
                <Input
                  id="device-code"
                  data-testid="device-approve-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABCD-EFGH"
                  autoCapitalize="characters"
                  autoComplete="off"
                  className="font-mono tracking-widest"
                  disabled={busy}
                />
              </div>
              <Button type="submit" disabled={busy} data-testid="device-approve-find">
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t("continue")}
              </Button>
            </form>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive" data-testid="device-approve-error">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
