"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Cpu,
  Globe,
  HardDrive,
  KeyRound,
  MemoryStick,
  RefreshCw,
  ShieldCheck,
  Volume2,
} from "lucide-react";
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
import { fetcher } from "lib/utils";
import type { ProviderConfig } from "@/lib/backend/provider-api";
import type { VoiceSettingsResponse } from "@/lib/backend/voice-api";
import {
  COMMON_TIMEZONES,
  detectBrowserTimezone,
} from "@/components/schedules/schedule-helpers";

export interface SystemInfo {
  version: string;
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

function VersionCard({ version }: { version?: string }) {
  return (
    <Card data-testid="general-version">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Version</CardTitle>
        <CardDescription>The Amiro build you are running.</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-6 text-sm">
        <span className="w-32 text-muted-foreground">Current</span>
        <span className="font-mono" data-testid="general-version-value">
          {version ? `v${version}` : "Unavailable"}
        </span>
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
      <TimezoneCard />
      <VersionCard version={data?.version} />
      <ResourcesCard
        info={data}
        loading={isLoading}
        refreshing={isValidating}
        onRefresh={() => void mutate()}
      />
    </div>
  );
}
