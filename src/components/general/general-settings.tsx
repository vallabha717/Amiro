"use client";

import {
  COMMON_TIMEZONES,
  detectBrowserTimezone,
} from "@/components/schedules/schedule-helpers";
import type { ProviderConfig } from "@/lib/backend/provider-api";
import type { VoiceSettingsResponse } from "@/lib/backend/voice-api";
import {
  checkBrowserPermission,
  isTauriDesktop,
  useNotifications,
} from "@/lib/notifications/notification-runtime";
import {
  refreshUpdateStatus,
  startServerUpdate,
  useUpdateStatus,
} from "@/lib/backend/update-api";
import { reopenOnboarding } from "@/lib/onboarding/onboarding-api";
import { fetcher } from "lib/utils";
import {
  ArrowRight,
  ArrowUpToLine,
  Bell,
  Bot,
  Check,
  Copy,
  Cpu,
  ExternalLink,
  Globe,
  HardDrive,
  KeyRound,
  Loader2,
  MemoryStick,
  Monitor,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";

export interface SystemInfo {
  version: string;
  deployment?: {
    mode: "desktop" | "vm-remote" | "local-server";
    bindHost: string;
    port: number;
    accessUrls: string[];
    desktopBundled: boolean;
  };
  cpu: { percent: number | null; cores: number | null };
  memory: { totalMb: number; usedMb: number } | null;
  disk: { totalMb: number; usedMb: number } | null;
}

const TZ_KEY = "amiro.timezone";

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function CapacityBar({
  value,
  max,
  caption,
}: {
  value: number;
  max: number;
  caption: string;
}) {
  const percent = max > 0 ? Math.max(0, Math.min((value / max) * 100, 100)) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          className={`h-full rounded-full transition-[width] duration-200 ${
            percent > 90 ? "bg-destructive" : "bg-emerald-500"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

function TimezoneCard() {
  const [tz, setTz] = useState<string>("");
  useEffect(() => {
    setTz(localStorage.getItem(TZ_KEY) || detectBrowserTimezone());
  }, []);
  const options = useMemo(
    () =>
      tz && !COMMON_TIMEZONES.includes(tz)
        ? [tz, ...COMMON_TIMEZONES]
        : COMMON_TIMEZONES,
    [tz],
  );
  return (
    <Card data-testid="general-timezone">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Timezone</CardTitle>
        <CardDescription>
          Used for schedules and for how times are shown to you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tz && (
          <Select
            value={tz}
            onValueChange={(v) => {
              setTz(v);
              localStorage.setItem(TZ_KEY, v);
            }}
          >
            <SelectTrigger
              className="w-full max-w-sm"
              data-testid="general-timezone-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {options.map((z) => (
                <SelectItem key={z} value={z}>
                  {z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function ResourcesCard({
  info,
  loading,
  refreshing,
  onRefresh,
}: {
  info?: SystemInfo;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const na = (
    <span className="text-xs text-muted-foreground">
      {loading ? "Loading…" : "Unavailable"}
    </span>
  );
  const cpu = info?.cpu.percent;
  return (
    <Card data-testid="general-resources">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-lg font-semibold">
            Compute and resources
          </CardTitle>
          <CardDescription>
            Live usage of the machine Amiro is running on.
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh metrics"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
        </Button>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile icon={<HardDrive className="size-3.5" />} label="Storage">
          {info?.disk ? (
            <CapacityBar
              value={info.disk.usedMb}
              max={info.disk.totalMb}
              caption={`${formatMb(info.disk.usedMb)} of ${formatMb(info.disk.totalMb)}`}
            />
          ) : (
            na
          )}
        </Tile>
        <Tile
          icon={<Cpu className="size-3.5" />}
          label={`CPU${info?.cpu.cores ? ` (${info.cpu.cores} cores)` : ""}`}
        >
          {cpu != null ? (
            <CapacityBar value={cpu} max={100} caption={`${cpu.toFixed(1)}%`} />
          ) : (
            na
          )}
        </Tile>
        <Tile icon={<MemoryStick className="size-3.5" />} label="Memory">
          {info?.memory ? (
            <CapacityBar
              value={info.memory.usedMb}
              max={info.memory.totalMb}
              caption={`${formatMb(info.memory.usedMb)} of ${formatMb(info.memory.totalMb)}`}
            />
          ) : (
            na
          )}
        </Tile>
      </CardContent>
    </Card>
  );
}

function SetupCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Card data-testid="general-setup">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Setup</CardTitle>
        <CardDescription>
          Walk through the welcome wizard again: agent name and look, and AI
          provider. Settings can also come from <code>amiro.toml</code> or a{" "}
          <code>.env</code> file (see docs/SETUP.md).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await reopenOnboarding();
              router.push("/onboarding");
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Could not reopen setup.",
              );
              setBusy(false);
            }
          }}
          data-testid="general-rerun-setup"
        >
          Run setup again
        </Button>
      </CardContent>
    </Card>
  );
}

function UpdateCard({
  version,
  deployment,
}: {
  version?: string;
  deployment?: SystemInfo["deployment"];
}) {
  const { data: update, isLoading, mutate } = useUpdateStatus(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateDone, setUpdateDone] = useState<string | null>(null);

  const isDesktop = deployment?.mode === "desktop";

  const onCheckAgain = async () => {
    setChecking(true);
    try {
      const fresh = await refreshUpdateStatus();
      await mutate(fresh, { revalidate: false });
    } catch {
      toast.error("Could not reach GitHub to check for updates.");
    } finally {
      setChecking(false);
    }
  };

  const onUpdateNow = async () => {
    if (!update?.latest || updating) return;
    setUpdating(true);
    try {
      const res = await startServerUpdate(update.latest);
      if (res.started) {
        setUpdateDone(res.version);
        toast.success(
          `Updating to ${res.version}: the server will restart. This page will reconnect on its own.`,
          { duration: 10000 },
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not start the update.",
      );
      setUpdating(false);
    }
  };

  const statusBadge = () => {
    if (isLoading) {
      return <Badge variant="secondary">Checking…</Badge>;
    }
    if (update?.checkFailed) {
      return (
        <Badge
          variant="outline"
          className="border-amber-500/30 text-amber-600 dark:text-amber-400"
        >
          Could not check
        </Badge>
      );
    }
    if (update?.noReleases) {
      return <Badge variant="secondary">No releases yet</Badge>;
    }
    if (update?.updateAvailable && update.latest) {
      return (
        <Badge className="bg-primary text-primary-foreground">
          Update available: {update.latest}
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
      >
        Up to date
      </Badge>
    );
  };

  return (
    <Card data-testid="general-version">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <ArrowUpToLine className="size-5 text-primary" />
              Version &amp; updates
            </CardTitle>
            <CardDescription>
              The Amiro build you are running, and whether a newer release is
              available.
            </CardDescription>
          </div>
          {statusBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-6 text-sm">
          <span className="w-32 text-muted-foreground">Current</span>
          <span className="font-mono" data-testid="general-version-value">
            {version ? `v${version}` : "Unavailable"}
          </span>
        </div>
        {update?.latest ? (
          <div className="flex gap-6 text-sm">
            <span className="w-32 text-muted-foreground">Latest</span>
            <a
              href={update.releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-primary hover:underline inline-flex items-center gap-1"
              data-testid="general-version-latest"
            >
              {update.latest}
              <ExternalLink className="size-3 shrink-0 opacity-70" />
            </a>
          </div>
        ) : null}
        {update?.checkFailed ? (
          <p className="text-xs text-muted-foreground">
            The release check needs internet access to github.com. Your server
            is unaffected. Try again when you are back online.
          </p>
        ) : null}
        {updateDone ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="general-update-progress"
          >
            Updating to {updateDone}… the server is restarting. This page
            reconnects automatically; if it does not, refresh in a minute.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {update?.updateAvailable &&
          update.latest &&
          !isDesktop &&
          !updateDone ? (
            <Button
              onClick={() => void onUpdateNow()}
              disabled={updating}
              data-testid="general-update-now"
            >
              {updating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Updating…
                </>
              ) : (
                <>Update to {update.latest}</>
              )}
            </Button>
          ) : null}
          {update?.updateAvailable && update.latest && isDesktop ? (
            <Button asChild data-testid="general-update-desktop-link">
              <a href={update.releaseUrl} target="_blank" rel="noreferrer">
                Download {update.latest}
                <ExternalLink className="size-4" />
              </a>
            </Button>
          ) : null}
          {!isDesktop ? (
            <Button
              variant="outline"
              onClick={() => void onCheckAgain()}
              disabled={checking || isLoading}
              data-testid="general-update-check"
            >
              <RefreshCw
                className={checking ? "size-4 animate-spin" : "size-4"}
              />
              Check again
            </Button>
          ) : null}
        </div>
        {isDesktop ? (
          <p className="text-xs text-muted-foreground">
            The desktop app has no auto-update feed yet: download the installer
            for your platform and reinstall. Your data and settings are kept.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            One click runs the same <code>amiro update</code> you would run in
            the terminal, then restarts the server. The two previous versions
            are kept for a quick rollback.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DeploymentCard({
  deployment,
  loading,
}: {
  deployment?: SystemInfo["deployment"];
  loading: boolean;
}) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopiedUrl(text);
        toast.success(`${label} copied to clipboard`);
        setTimeout(() => setCopiedUrl(null), 2000);
      }
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const mode = deployment?.mode ?? "local-server";
  let modeLabel = "Local Server";
  let modeBadgeClass =
    "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10";
  if (mode === "vm-remote") {
    modeLabel = "VM / Remote Web UI Server";
    modeBadgeClass =
      "border-blue-500/30 text-blue-600 dark:text-blue-400 bg-blue-500/10";
  } else if (mode === "desktop") {
    modeLabel = "Desktop Application";
    modeBadgeClass =
      "border-purple-500/30 text-purple-600 dark:text-purple-400 bg-purple-500/10";
  }

  const bindAddress = deployment
    ? `${deployment.bindHost}:${deployment.port}`
    : loading
      ? "Loading…"
      : "Unavailable";
  const urls = deployment?.accessUrls?.length
    ? deployment.accessUrls
    : deployment?.port
      ? [`http://localhost:${deployment.port}`]
      : [];

  return (
    <Card data-testid="general-deployment-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <Server className="size-5 text-primary" />
              Deployment &amp; Access (VM Web UI &amp; Desktop App)
            </CardTitle>
            <CardDescription>
              Network topology, reachable URLs across devices, and launcher
              commands.
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            className={`text-xs px-2.5 py-0.5 font-medium ${modeBadgeClass}`}
            data-testid="general-deployment-mode-badge"
          >
            {modeLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Topology Summary */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-1">
            <span className="text-muted-foreground flex items-center gap-1.5 font-medium">
              <Network className="size-3.5 text-primary" />
              Bind Address
            </span>
            <p
              className="font-mono text-sm font-semibold text-foreground"
              data-testid="general-deployment-bind"
            >
              {bindAddress}
            </p>
            <p className="text-muted-foreground">
              {mode === "vm-remote"
                ? "Bound to 0.0.0.0 (accepts connections from any network interface)"
                : mode === "desktop"
                  ? "Bound to loopback with Tauri desktop native bridge enabled"
                  : "Bound to loopback interface (local machine only)"}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-1">
            <span className="text-muted-foreground flex items-center gap-1.5 font-medium">
              <Monitor className="size-3.5 text-primary" />
              Desktop App Engine
            </span>
            <p className="text-sm font-semibold text-foreground">
              {deployment?.desktopBundled
                ? "Bundled Native Sidecars"
                : "Standalone / Web Engine"}
            </p>
            <p className="text-muted-foreground">
              {deployment?.desktopBundled
                ? "Packaged Tauri desktop layout with owned runtime beside executable"
                : "Standard distribution with local runtime bridge"}
            </p>
          </div>
        </div>

        {/* Reachable Web UI URLs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
            <span className="flex items-center gap-1.5 text-foreground">
              <Globe className="size-3.5 text-primary" />
              Reachable Web UI URLs (Open in any browser / device)
            </span>
            <span>
              {urls.length} reachable{" "}
              {urls.length === 1 ? "address" : "addresses"}
            </span>
          </div>
          <div className="space-y-1.5" data-testid="general-deployment-urls">
            {urls.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                {loading
                  ? "Discovering access URLs…"
                  : "No access URLs available."}
              </p>
            ) : (
              urls.map((url) => {
                const isCopied = copiedUrl === url;
                return (
                  <div
                    key={url}
                    className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-1.5 text-xs font-mono"
                  >
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-primary hover:underline flex items-center gap-1"
                    >
                      {url}
                      <ExternalLink className="size-3 shrink-0 opacity-70" />
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={() => void copyToClipboard(url, "URL")}
                      aria-label={`Copy ${url}`}
                    >
                      {isCopied ? (
                        <>
                          <Check className="size-3 text-emerald-500" />
                          <span className="text-emerald-500 text-[11px]">
                            Copied
                          </span>
                        </>
                      ) : (
                        <>
                          <Copy className="size-3" />
                          <span className="text-[11px]">Copy</span>
                        </>
                      )}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Quick Command Reference */}
        <div className="space-y-2 pt-1 border-t">
          <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Terminal className="size-3.5 text-primary" />
            Quick Command Reference
          </span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
            <div className="rounded-md border bg-muted/40 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground">
                  VM / Remote Web UI Server
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px] gap-1"
                  onClick={() =>
                    void copyToClipboard(
                      "./scripts/amiro-server.sh start --host 0.0.0.0 --port 3000",
                      "VM command",
                    )
                  }
                >
                  <Copy className="size-2.5" />
                  Copy
                </Button>
              </div>
              <code className="block rounded bg-background/80 p-1.5 font-mono text-[11px] text-muted-foreground select-all break-all">
                ./scripts/amiro-server.sh start --host 0.0.0.0 --port 3000
              </code>
            </div>
            <div className="rounded-md border bg-muted/40 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground">
                  Desktop Application
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px] gap-1"
                  onClick={() =>
                    void copyToClipboard(
                      "pnpm desktop:start",
                      "Desktop command",
                    )
                  }
                >
                  <Copy className="size-2.5" />
                  Copy
                </Button>
              </div>
              <code className="block rounded bg-background/80 p-1.5 font-mono text-[11px] text-muted-foreground select-all break-all">
                pnpm desktop:start
              </code>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfiguredDefaultsCard() {
  const { data: providers = [] } = useSWR<ProviderConfig[]>(
    "/api/ai/providers",
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: searchActive } = useSWR<{
    configured: boolean;
    provider?: string;
    label?: string;
  }>("/api/search/active", fetcher, { revalidateOnFocus: false });
  const { data: voiceData } = useSWR<VoiceSettingsResponse>(
    "/api/voice/settings",
    fetcher,
    { revalidateOnFocus: false },
  );
  const { data: credentialsData } = useSWR<{
    items: Array<{
      id: string;
      service: string;
      field: string;
      hint: string;
      label?: string;
    }>;
  }>("/api/credentials", fetcher, { revalidateOnFocus: false });
  const { unreadCount } = useNotifications();
  const [browserPermission, setBrowserPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");
  const desktop = useMemo(() => isTauriDesktop(), []);

  useEffect(() => {
    setBrowserPermission(checkBrowserPermission());
  }, []);

  // 1. Default AI Model & Provider
  const providerList = Array.isArray(providers) ? providers : [];
  const connectedCount = providerList.length;
  const totalModels = providerList.reduce(
    (acc, p) => acc + (p.models?.length || 0),
    0,
  );
  const primaryProvider =
    providerList.find((p) => p.selectedModel) || providerList[0];
  const activeModel =
    primaryProvider?.selectedModel ||
    primaryProvider?.models?.[0] ||
    "claude-opus-5-5";
  const activeProviderName = primaryProvider?.name || "Connected Provider";

  // 2. Default Web Search Provider
  const searchConfigured = searchActive?.configured ?? false;
  const searchLabel = searchConfigured
    ? searchActive?.label || searchActive?.provider || "Provider Native"
    : "Provider Native / None configured";

  // 3. Default Voice & Speech
  const voiceSettings = voiceData?.settings;
  const liveVoice = voiceSettings?.liveVoice;
  const ttsProvider = voiceSettings?.ttsProvider || "elevenlabs";
  const ttsState = voiceSettings?.ttsProviders?.[ttsProvider];
  const sttProvider = voiceSettings?.sttProvider || "elevenlabs";
  const sttState = voiceSettings?.sttProviders?.[sttProvider];
  const voiceKeyHint =
    liveVoice?.apiKeyHint || ttsState?.apiKeyHint || sttState?.apiKeyHint;
  const activeVoiceName = liveVoice?.voiceName || "Sarah";
  const activeTtsModel =
    ttsState?.model || liveVoice?.ttsModel || "eleven_turbo_v2_5";
  const activeSttModel = sttState?.model || liveVoice?.sttModel || "scribe_v1";
  const voiceProviderDisplay =
    liveVoice?.displayName ||
    (ttsProvider === "elevenlabs" ? "ElevenLabs" : ttsProvider);

  // 4. Encrypted Credential Vault
  const vaultItems = credentialsData?.items || [];
  const vaultCount = vaultItems.length;

  return (
    <Card data-testid="general-configured-defaults">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          Configured System Defaults
        </CardTitle>
        <CardDescription>
          Active defaults and connections configured across Amiro services.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* AI Model & Provider */}
          <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Bot className="size-4 text-primary" />
                  Default Chat Model &amp; Provider
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] px-1.5"
                >
                  {connectedCount} Connected
                </Badge>
              </div>
              <p className="text-foreground font-medium text-sm">
                {activeProviderName} ·{" "}
                <span className="font-mono">{activeModel}</span>
              </p>
              <p className="text-muted-foreground">
                {connectedCount} connected provider
                {connectedCount === 1 ? "" : "s"} · {totalModels} model
                {totalModels === 1 ? "" : "s"} available
              </p>
            </div>
            <Link
              href="/admin/providers"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline self-start pt-1"
            >
              Configure <ArrowRight className="size-3" />
            </Link>
          </div>

          {/* Web Search Provider */}
          <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Globe className="size-4 text-primary" />
                  Default Web Search Provider
                </span>
                <Badge
                  variant={searchConfigured ? "outline" : "secondary"}
                  className={
                    searchConfigured
                      ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] px-1.5"
                      : "text-[10px] px-1.5"
                  }
                >
                  {searchConfigured ? "Active" : "Default"}
                </Badge>
              </div>
              <p className="text-foreground font-medium text-sm">
                {searchLabel}
              </p>
              <p className="text-muted-foreground">
                Used for online retrieval and real-time knowledge synthesis.
              </p>
            </div>
            <Link
              href="/admin/search"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline self-start pt-1"
            >
              Configure <ArrowRight className="size-3" />
            </Link>
          </div>

          {/* Voice & Speech */}
          <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Volume2 className="size-4 text-primary" />
                  Voice &amp; Speech Defaults
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] px-1.5"
                >
                  {voiceKeyHint ? `Configured (${voiceKeyHint})` : "Active"}
                </Badge>
              </div>
              <p className="text-foreground font-medium text-sm">
                {voiceProviderDisplay}
                {voiceKeyHint ? ` · ${voiceKeyHint}` : ""}
              </p>
              <p className="text-muted-foreground">
                Voice:{" "}
                <span className="text-foreground font-medium">
                  {activeVoiceName}
                </span>{" "}
                · TTS: <span className="font-mono">{activeTtsModel}</span> ·
                STT: <span className="font-mono">{activeSttModel}</span>
              </p>
            </div>
            <Link
              href="/admin/voice"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline self-start pt-1"
            >
              Configure <ArrowRight className="size-3" />
            </Link>
          </div>

          {/* Credential Vault */}
          <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <KeyRound className="size-4 text-primary" />
                  Encrypted Credential Vault
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] px-1.5"
                >
                  {vaultCount} Vaulted
                </Badge>
              </div>
              <p className="text-foreground font-medium text-sm">
                {vaultCount} vaulted credential{vaultCount === 1 ? "" : "s"}
              </p>
              <p className="text-muted-foreground truncate">
                {vaultCount > 0
                  ? vaultItems
                      .map((i) => `${i.service} (${i.hint})`)
                      .slice(0, 3)
                      .join(", ") + (vaultCount > 3 ? "…" : "")
                  : "No external API credentials vaulted yet."}
              </p>
            </div>
            <Link
              href="/admin/credentials"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline self-start pt-1"
            >
              Configure <ArrowRight className="size-3" />
            </Link>
          </div>

          {/* Notifications & Alerts */}
          <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Bell className="size-4 text-primary" />
                  Notifications &amp; Alerts
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] px-1.5"
                >
                  {unreadCount} Unread
                </Badge>
              </div>
              <p className="text-foreground font-medium text-sm">
                {browserPermission === "granted"
                  ? "Web notifications enabled"
                  : "Web notifications prompt"}
                {desktop ? " · Desktop active" : ""}
              </p>
              <p className="text-muted-foreground">
                {unreadCount > 0
                  ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"} waiting.`
                  : "No unread notifications."}
              </p>
            </div>
            <Link
              href="/admin/notifications"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline self-start pt-1"
            >
              Configure <ArrowRight className="size-3" />
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function GeneralSettings() {
  const { data, isLoading, isValidating, mutate } = useSWR<SystemInfo>(
    "/api/system",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 15000, errorRetryCount: 1 },
  );
  return (
    <div className="flex flex-col gap-4">
      <ConfiguredDefaultsCard />
      <DeploymentCard deployment={data?.deployment} loading={isLoading} />
      <TimezoneCard />
      <SetupCard />
      <UpdateCard version={data?.version} deployment={data?.deployment} />
      <ResourcesCard
        info={data}
        loading={isLoading}
        refreshing={isValidating}
        onRefresh={() => void mutate()}
      />
    </div>
  );
}
