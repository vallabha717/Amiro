"use client";

export const COMMON_TIMEZONES: string[] = (() => {
  let base: string[] = [];
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) base = supported.slice();
  } catch {}
  if (base.length === 0) {
    base = [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Anchorage",
      "Pacific/Honolulu",
      "America/Sao_Paulo",
      "Europe/London",
      "Europe/Berlin",
      "Europe/Paris",
      "Europe/Moscow",
      "Africa/Cairo",
      "Asia/Dubai",
      "Asia/Kolkata",
      "Asia/Shanghai",
      "Asia/Tokyo",
      "Asia/Seoul",
      "Australia/Sydney",
      "Pacific/Auckland",
    ];
  }
  // Ensure UTC is always selectable even when supportedValuesOf excludes it or
  // aliases like Asia/Calcutta vs Asia/Kolkata cause drift.
  if (!base.includes("UTC")) base.unshift("UTC");
  return base;
})();

export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Convert a `datetime-local` value (YYYY-MM-DDTHH:mm) that the user
 * entered *as wall time in the selected IANA zone* into the `at` string the
 * backend expects: wall time without offset, `YYYY-MM-DDTHH:mm:00`.
 *
 * Critical: never do `new Date(value).toISOString()` — that interprets the
 * input in the *browser's* zone, not the schedule's zone.
 * The backend stores `at` as wall time + `timezone`, so we send wall time
 * verbatim and let the daemon resolve the instant on tick (DST gaps are
 * surfaced by the preview/validation step).
 */
export function wallTimeToAt(wallLocal: string): string {
  if (!wallLocal) return wallLocal;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(wallLocal)) return wallLocal;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wallLocal)) return `${wallLocal}:00`;
  return wallLocal;
}

/**
 * Convert a stored `at` value back to a `datetime-local` wall string for the
 * given schedule timezone. The stored `at` may be wall time without offset
 * (`2026-03-29T02:30:00`) or already UTC (`...Z` / with offset) if the backend
 * normalized it. In the latter case we render it in the schedule's wall zone.
 */
export function storedAtToWallLocal(
  at: string,
  timeZone: string,
): string {
  if (!at) return "";
  // Wall time without zone/offset — already what datetime-local wants.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(at)) {
    return at.slice(0, 16);
  }
  // ISO with Z/offset — convert to that zone's wall time.
  try {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return at.slice(0, 16);
    // Use Intl to extract wall components in timeZone, then reassemble.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const yyyy = get("year");
    const mm = get("month");
    const dd = get("day");
    const hh = get("hour");
    const min = get("minute");
    if (yyyy && mm && dd && hh && min) return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  } catch {}
  return at.slice(0, 16);
}

/**
 * For display only: render a UTC ISO in the schedule's wall timezone.
 */
export function formatInTimezone(
  isoUtc: string | null,
  timeZone: string,
): string {
  if (!isoUtc) return "—";
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return isoUtc;
  try {
    return d.toLocaleString(undefined, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
  } catch {
    return d.toLocaleString();
  }
}

/**
 * Build a 5-field cron from a preset. Caller provides HH:MM and optional
 * day/weekday, returned `0-59 0-23 * * *` in wall time of the schedule.
 */
export function presetToCron(
  preset:
    | { kind: "daily"; time: string }
    | { kind: "weekdays"; time: string }
    | { kind: "weekly"; time: string; weekday: number }
    | { kind: "monthly"; time: string; day: number },
): string {
  const [hhStr, mmStr] = preset.time.split(":");
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  if (preset.kind === "daily") return `${mm} ${hh} * * *`;
  if (preset.kind === "weekdays") return `${mm} ${hh} * * 1-5`;
  if (preset.kind === "weekly") {
    const dow = preset.weekday % 7;
    return `${mm} ${hh} * * ${dow}`;
  }
  return `${mm} ${hh} ${preset.day} * *`;
}

export function cronToPresetLabel(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mmS, hhS, dom, mon, dow] = parts;
  if (!/^\d+$/.test(mmS) || !/^\d+$/.test(hhS)) return null;
  const hh = Number(hhS);
  const mm = Number(mmS);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(hh)}:${pad(mm)}`;
  if (dom === "*" && mon === "*" && dow === "*") return `Daily ${time}`;
  if (dom === "*" && mon === "*" && dow === "1-5") return `Weekdays ${time}`;
  if (dom !== "*" && mon === "*" && dow === "*") return `Monthly day ${dom} ${time}`;
  if (dom === "*" && mon === "*" && dow !== "*" && /^\d$/.test(dow)) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `Weekly ${days[Number(dow)] ?? dow} ${time}`;
  }
  return null;
}

export const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
] as const;

/**
 * Minimal client-side validation — only field count. Full cron parsing
 * (MON, MON-FRI, 0-30/5 etc) is deferred to the backend preview/parser so we
 * do not reject valid standard cron that our regex does not cover.
 */
export function validateCronExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return "Cron expression is required";
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return "Use 5 fields: minute hour day month weekday";
  return null;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const costFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatScheduleCost(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "—";
  return costFormatter.format(cost);
}

export function formatScheduleRunCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "run" : "runs"}`;
}

export interface GroupedSchedules<T> {
  recurring: T[];
  upcomingOneTime: T[];
  pastOneTime: T[];
}

export function isOneShotSchedule(s: {
  isOneShot?: boolean;
  schedule: { kind: string };
}): boolean {
  return s.isOneShot ?? s.schedule.kind === "once";
}

export function isPastOneTimeSchedule(
  s: {
    isOneShot?: boolean;
    schedule: { kind: string };
    status?: string;
    enabled: boolean;
    nextRunAt: string | null;
    lastStatus?: string | null;
  },
  nowMs: number = Date.now(),
): boolean {
  if (!isOneShotSchedule(s)) return false;
  if (s.status === "fired" || s.status === "cancelled") return true;
  if (s.status === "firing") return false;
  if (
    s.lastStatus === "ok" ||
    s.lastStatus === "failed" ||
    s.lastStatus === "skipped"
  ) {
    return true;
  }
  if (!s.nextRunAt) return true;
  const due = new Date(s.nextRunAt).getTime();
  return !s.enabled && Number.isFinite(due) && due <= nowMs;
}

export function groupSchedules<
  T extends {
    isOneShot?: boolean;
    schedule: { kind: string };
    status?: string;
    enabled: boolean;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastStatus?: string | null;
  },
>(schedules: T[], nowMs: number = Date.now()): GroupedSchedules<T> {
  const recurring: T[] = [];
  const upcomingOneTime: T[] = [];
  const pastOneTime: T[] = [];

  for (const s of schedules) {
    if (!isOneShotSchedule(s)) {
      recurring.push(s);
    } else if (isPastOneTimeSchedule(s, nowMs)) {
      pastOneTime.push(s);
    } else {
      upcomingOneTime.push(s);
    }
  }

  return { recurring, upcomingOneTime, pastOneTime };
}
