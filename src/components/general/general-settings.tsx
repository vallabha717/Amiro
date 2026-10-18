"use client";

import { useEffect, useMemo, useState } from "react";
import { Cpu, HardDrive, MemoryStick, RefreshCw } from "lucide-react";
import useSWR from "swr";
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

export function GeneralSettings() {
  const { data, isLoading, isValidating, mutate } = useSWR<SystemInfo>(
    "/api/system",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 15000, errorRetryCount: 1 },
  );
  return (
    <div className="flex flex-col gap-4">
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
