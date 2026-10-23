"use client";

import {
  answerRequest,
  type DeviceRequest,
  devicesKey,
  type DevicesOverview,
  type PairedDevice,
  revokeDevice,
  setRemoteAccess,
} from "@/lib/backend/devices-api";
import {
  disconnectRemote,
  getRemoteOrigin,
  hasLocalBackend,
} from "@/lib/backend/config";
import { fetcher } from "@/lib/backend/client";
import {
  Check,
  Cloud,
  Loader2,
  Monitor,
  QrCode,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Wifi,
  X,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Badge } from "ui/badge";
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
import { Switch } from "ui/switch";
import { DeviceIcon } from "./device-icon";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Which Amiro this app is using, and the way back for the desktop app. */
function ConnectionCard() {
  const t = useTranslations("Devices.Connection");
  const [remote, setRemote] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    setRemote(getRemoteOrigin());
    setDesktop(hasLocalBackend());
  }, []);
  // Only an app that can point somewhere else has a choice to show.
  if (!desktop && !remote) return null;
  return (
    <Card data-testid="devices-connection">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border p-3">
          {remote ? (
            <Cloud className="size-5 text-muted-foreground" />
          ) : (
            <Monitor className="size-5 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium" data-testid="devices-connection-current">
              {remote ? t("remote") : t("local")}
            </p>
            {remote && (
              <p className="truncate font-mono text-xs text-muted-foreground">{remote}</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" data-testid="devices-connect-other">
            <Link href="/pair">
              <Cloud className="size-4" />
              {t("connectOther")}
            </Link>
          </Button>
          {remote && desktop && (
            <Button
              variant="outline"
              data-testid="devices-switch-back"
              onClick={() => {
                disconnectRemote();
                window.location.assign("/");
              }}
            >
              <Monitor className="size-4" />
              {t("switchBack")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The desktop app's local-network listener for phones. */
function PhoneAccessCard({
  overview,
  onChange,
}: {
  overview: DevicesOverview;
  onChange: (next: DevicesOverview) => void;
}) {
  const t = useTranslations("Devices.PhoneAccess");
  const remote = overview.remoteAccess;
  const [port, setPort] = useState(String(remote.port));
  const [busy, setBusy] = useState(false);
  useEffect(() => setPort(String(remote.port)), [remote.port]);

  const apply = async (enabled: boolean) => {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      toast.error(t("badPort"));
      return;
    }
    setBusy(true);
    try {
      const next = await setRemoteAccess(enabled, value);
      onChange(next);
      if (next.remoteAccess.error) toast.error(next.remoteAccess.error);
      else toast.success(enabled ? t("turnedOn") : t("turnedOff"));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="devices-phone-access">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          <Wifi className="size-5" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex items-center gap-3">
            <Switch
              id="phone-access"
              checked={remote.enabled}
              disabled={busy}
              onCheckedChange={apply}
              data-testid="devices-phone-access-switch"
            />
            <Label htmlFor="phone-access">{t("switch")}</Label>
            {busy && <Loader2 className="size-4 animate-spin" />}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="phone-access-port" className="text-xs">
              {t("port")}
            </Label>
            <Input
              id="phone-access-port"
              data-testid="devices-phone-access-port"
              className="w-28"
              inputMode="numeric"
              value={port}
              disabled={busy}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
              onBlur={() => {
                if (remote.enabled && port !== String(remote.port)) apply(true);
              }}
            />
          </div>
        </div>
        <div data-testid="devices-phone-access-status">
          {remote.listening ? (
            <div className="flex flex-col gap-1">
              <Badge variant="secondary" className="w-fit">
                {t("listening", { port: remote.port })}
              </Badge>
              {remote.urls.map((url) => (
                <code key={url} className="font-mono text-xs text-muted-foreground">
                  {url}
                </code>
              ))}
            </div>
          ) : remote.error ? (
            <p role="alert" className="text-sm text-destructive">
              {remote.error}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("off")}</p>
          )}
        </div>
        <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
          <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          {t("warning")}
        </p>
      </CardContent>
    </Card>
  );
}

/** Devices asking to connect right now, approved or denied from here. On
 * Wi-Fi this is where the owner approves, on the computer itself. */
function RequestsCard({
  requests,
  onAnswered,
}: {
  requests: DeviceRequest[];
  onAnswered: () => void;
}) {
  const t = useTranslations("Devices.Requests");
  const tApprove = useTranslations("Devices.Approve");
  const format = useFormatter();
  const [busy, setBusy] = useState<string | null>(null);
  const answer = async (request: DeviceRequest, approve: boolean) => {
    setBusy(request.id);
    try {
      await answerRequest(request.id, approve);
      toast.success(
        approve
          ? tApprove("approved", { name: request.name })
          : tApprove("denied", { name: request.name }),
      );
      onAnswered();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card data-testid="devices-requests">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              {tApprove("warning")}
            </p>
            <ul className="flex flex-col divide-y">
              {requests.map((request) => (
                <li
                  key={request.id}
                  className="flex flex-wrap items-center gap-3 py-3"
                  data-testid="devices-request"
                >
                  <DeviceIcon platform={request.platform} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{request.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {tApprove(`platform.${request.platform}`)}
                      {request.address
                        ? ` · ${tApprove("from", { address: request.address })}`
                        : ""}
                      {" · "}
                      {format.relativeTime(new Date(request.createdAt), new Date())}
                    </p>
                  </div>
                  <code
                    className="font-mono text-base font-semibold tracking-widest"
                    data-testid="devices-request-code"
                  >
                    {request.userCode}
                  </code>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy === request.id}
                      onClick={() => answer(request, true)}
                      data-testid="devices-request-approve"
                    >
                      <Check className="size-4" />
                      {tApprove("approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === request.id}
                      onClick={() => answer(request, false)}
                      data-testid="devices-request-deny"
                    >
                      <X className="size-4" />
                      {tApprove("deny")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** How to connect a device: the address to type, as text and a QR code. */
function ConnectCard({ overview }: { overview: DevicesOverview }) {
  const t = useTranslations("Devices.ConnectCard");
  // A desktop install is reachable only while phone access is on.
  const blocked = overview.remoteAccess.needed && !overview.remoteAccess.listening;
  const link = overview.links[0];
  return (
    <Card data-testid="devices-connect">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          <QrCode className="size-5" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {blocked ? (
          <p className="text-sm text-muted-foreground">{t("turnOnFirst")}</p>
        ) : overview.links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noAddress")}</p>
        ) : (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start sm:gap-6">
            {link?.qrSvg && (
              <img
                src={`data:image/svg+xml;utf8,${encodeURIComponent(link.qrSvg)}`}
                alt={t("qrAlt")}
                className="size-40 rounded-lg border bg-white p-1"
                data-testid="devices-connect-qr"
              />
            )}
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-xs text-muted-foreground">{t("addressLabel")}</p>
              {overview.links.map((item) => (
                <code
                  key={item.url}
                  className="break-all font-mono text-sm"
                  data-testid="devices-connect-address"
                >
                  {item.url}
                </code>
              ))}
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                <li>{t("step1")}</li>
                <li>{t("step2")}</li>
                <li>{t("step3")}</li>
              </ol>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceList({
  devices,
  onChange,
}: {
  devices: PairedDevice[];
  onChange: (next: DevicesOverview) => void;
}) {
  const t = useTranslations("Devices.List");
  const format = useFormatter();
  const [busy, setBusy] = useState<string | null>(null);
  const revoke = async (device: PairedDevice) => {
    if (!window.confirm(t("confirm", { name: device.name }))) return;
    setBusy(device.id);
    try {
      onChange(await revokeDevice(device.id));
      toast.success(t("revoked", { name: device.name }));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card data-testid="devices-list">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex items-center gap-3 py-3"
                data-testid="devices-list-item"
              >
                <DeviceIcon platform={device.platform} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{device.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("pairedOn", {
                      date: format.dateTime(new Date(device.createdAt), {
                        dateStyle: "medium",
                      }),
                    })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("revoke", { name: device.name })}
                  disabled={busy === device.id}
                  onClick={() => revoke(device)}
                  data-testid="devices-list-revoke"
                >
                  {busy === device.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Settings → Devices. */
export function DevicesSettings() {
  const t = useTranslations("Devices");
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);
  // Refreshed every few seconds so a device asking to connect shows up.
  const { data, error, mutate } = useSWR<DevicesOverview>(
    origin ? devicesKey(origin) : null,
    fetcher,
    { refreshInterval: 3000 },
  );
  const update = (next: DevicesOverview) =>
    mutate({ ...next, links: data?.links ?? next.links }, { revalidate: true });
  return (
    <div className="flex flex-col gap-6">
      <ConnectionCard />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(error)}
        </p>
      )}
      {!data && !error && (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />
      )}
      {data && (
        <>
          <RequestsCard requests={data.requests} onAnswered={() => mutate()} />
          {data.remoteAccess.needed && <PhoneAccessCard overview={data} onChange={update} />}
          <ConnectCard overview={data} />
          <DeviceList devices={data.devices} onChange={update} />
        </>
      )}
    </div>
  );
}
