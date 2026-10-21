import { useEffect, useMemo, useRef } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { toast } from "sonner";
import { getSessionToken, getBackendSharedSecret, backendUrl } from "@/lib/backend/config";
import { appStore } from "@/app/store";
import {
  NOTIFICATIONS_LIST_KEY,
  NOTIFICATIONS_STREAM_PATH,
  fetchNotifications,
  ackNotificationDelivery,
  buildThreadUrl,
  buildScheduleUrl,
  parseDeepLinkTarget,
  parseNotification,
  resolveDeepLinkTarget,
  getCachedNotificationSettings,
  type AmiroNotification,
  type NotificationCategory,
  type NotificationDeepLinkTarget,
  type NotificationDeliveryPayload,
  type NotificationReceiptClass,
  type NotificationSettings,
} from "./notification-types";

declare global {
  interface Window {
    __TAURI__?: {
      invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      core?: {
        invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
    __TAURI_INTERNALS__?: unknown;
    __TAURI_INTERNals__?: unknown;
    __AMIRO_DESKTOP__?: boolean;
    __AMIRO_DESKTOP_NOTIFY__?: (
      payload: NotificationDeliveryPayload,
    ) => Promise<void> | void;
  }
}

// ============================================================================
// Cross-Tab Deduplication & Attention Engine (modeled on Vellum)
// ============================================================================

const STORAGE_KEY = "amiro:browser-notification-deliveries:v1";
const SOUND_STORAGE_KEY = "amiro:browser-notification-sounds:v1";
const DELIVERY_RECORD_PREFIX = "amiro:notifications:delivery:";
const DELIVERY_RECORD_TTL_MS = 1000 * 60 * 60 * 24;
const DATABASE_NAME = "amiro-browser-notifications";
const RECEIPTS_STORE = "receipts";
const MAX_DELIVERIES = 128;
const RETENTION_MS = 10 * 60_000;
const ATTENTION_PREFIX = "amiro:browser-notification-attention:v1:";
const ATTENTION_TTL_MS = 15_000;
const ATTENTION_REFRESH_MS = 5_000;

export type DeliveryResult = "posted" | "duplicate" | "cancelled" | "suppressed";
export type ClaimResult = "claimed" | Exclude<DeliveryResult, "posted">;

function openReceiptDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE_NAME, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        try {
          request.result.createObjectStore(RECEIPTS_STORE);
        } catch {}
      };
      request.onsuccess = () => {
        if (blocked) {
          try {
            request.result.close();
          } catch {}
          resolve(null);
        } else {
          resolve(request.result);
        }
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => {
        blocked = true;
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

export function browserNotificationConversationKey(
  threadId: string | null | undefined,
): string | null {
  return threadId ? `thread:${threadId}` : null;
}

export function hasRecentlyDelivered(deliveryId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(`${DELIVERY_RECORD_PREFIX}${deliveryId}`);
    if (!raw) return false;
    const ts = Number.parseInt(raw, 10);
    if (!ts) return false;
    return Date.now() - ts < DELIVERY_RECORD_TTL_MS;
  } catch {
    return false;
  }
}

export function recordDelivery(deliveryId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${DELIVERY_RECORD_PREFIX}${deliveryId}`,
      Date.now().toString(),
    );
  } catch {}
}

export class BrowserNotificationDelivery {
  private recent = new Map<string, number>();
  private recentSounds = new Map<string, number>();
  private attentionReaders = new Set<() => string | null>();

  trackAttention(readConversationKey: () => string | null): () => void {
    if (typeof window === "undefined") return () => {};
    const storageKey = `${ATTENTION_PREFIX}${Math.random().toString(36).slice(2)}`;
    this.attentionReaders.add(readConversationKey);
    let published = false;

    const update = () => {
      try {
        const conversationKey = readConversationKey();
        if (conversationKey) {
          window.localStorage.setItem(
            storageKey,
            JSON.stringify([conversationKey, Date.now() + ATTENTION_TTL_MS]),
          );
          published = true;
        } else if (published) {
          window.localStorage.removeItem(storageKey);
          published = false;
        }
      } catch {}
    };

    const interval = setInterval(update, ATTENTION_REFRESH_MS);
    update();

    return () => {
      this.attentionReaders.delete(readConversationKey);
      clearInterval(interval);
      try {
        window.localStorage.removeItem(storageKey);
      } catch {}
    };
  }

  isConversationAttended(conversationKey: string | null): boolean {
    if (!conversationKey) return false;
    if (typeof window === "undefined") return false;

    const locallyAttended = [...this.attentionReaders].some(
      (read) => read() === conversationKey,
    );
    const doc = typeof document !== "undefined" ? document : (window as any).document;
    if (locallyAttended && doc?.visibilityState === "visible") {
      return true;
    }

    const now = Date.now();
    try {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const storageKey = window.localStorage.key(i);
        if (!storageKey?.startsWith(ATTENTION_PREFIX)) continue;

        let entry: unknown;
        try {
          entry = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
        } catch {
          window.localStorage.removeItem(storageKey);
          continue;
        }

        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          typeof entry[1] !== "number" ||
          entry[1] <= now ||
          entry[1] > now + ATTENTION_TTL_MS
        ) {
          window.localStorage.removeItem(storageKey);
          continue;
        }

        if (entry[0] === conversationKey) {
          return true;
        }
      }
    } catch {}

    return false;
  }

  resetForTests(): void {
    this.recent.clear();
    this.recentSounds.clear();
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(SOUND_STORAGE_KEY);
        for (let i = window.localStorage.length - 1; i >= 0; i--) {
          const k = window.localStorage.key(i);
          if (k?.startsWith(DELIVERY_RECORD_PREFIX)) {
            window.localStorage.removeItem(k);
          }
        }
      } catch {}
    }
  }

  async post(
    key: string | null,
    deliver: () => void,
    canDeliver: () => boolean = () => true,
    conversationKey: string | null = null,
  ): Promise<DeliveryResult> {
    const result = await this.claim(
      "post",
      key,
      deliver,
      canDeliver,
      conversationKey,
    );
    return result === "claimed" ? "posted" : result;
  }

  claimSound(
    key: string | null,
    canDeliver: () => boolean = () => true,
    conversationKey: string | null = null,
  ): Promise<ClaimResult> {
    return this.claim("sound", key, () => undefined, canDeliver, conversationKey);
  }

  private async claim(
    kind: "post" | "sound",
    key: string | null,
    deliver: () => void,
    canDeliver: () => boolean,
    conversationKey: string | null,
  ): Promise<ClaimResult> {
    if (!canDeliver()) return "cancelled";
    if (this.isConversationAttended(conversationKey)) return "suppressed";
    if (!key) {
      deliver();
      return "claimed";
    }

    const storageKey = kind === "post" ? STORAGE_KEY : SOUND_STORAGE_KEY;
    const recent = kind === "post" ? this.recent : this.recentSounds;
    const now = Date.now();

    const memExpiry = recent.get(key);
    if (memExpiry && memExpiry > now) {
      return "duplicate";
    }

    if (typeof window !== "undefined") {
      try {
        const stored: [string, number][] = JSON.parse(
          window.localStorage.getItem(storageKey) ?? "[]",
        );
        const match = stored.find(([k, exp]) => k === key && exp > now);
        if (match) {
          recent.set(key, match[1]);
          return "duplicate";
        }
      } catch {}
    }

    const db = await openReceiptDatabase();
    if (db) {
      try {
        const claimed = await new Promise<boolean>((resolve) => {
          const tx = db.transaction(RECEIPTS_STORE, "readwrite");
          const store = tx.objectStore(RECEIPTS_STORE);
          const fullKey = `${kind}:${key}`;
          const getReq = store.get(fullKey);

          getReq.onsuccess = () => {
            const exp = getReq.result;
            if (typeof exp === "number" && exp > now) {
              resolve(false);
            } else {
              store.put(now + RETENTION_MS, fullKey);
              resolve(true);
            }
          };
          getReq.onerror = () => resolve(true);
          tx.oncomplete = () => {};
          tx.onerror = () => resolve(true);
        });

        if (!claimed) {
          recent.set(key, now + RETENTION_MS);
          return "duplicate";
        }
      } catch {}
    }

    recent.set(key, now + RETENTION_MS);
    if (typeof window !== "undefined") {
      try {
        const stored: [string, number][] = JSON.parse(
          window.localStorage.getItem(storageKey) ?? "[]",
        );
        const valid = stored.filter(([k, exp]) => k !== key && exp > now);
        valid.push([key, now + RETENTION_MS]);
        if (valid.length > MAX_DELIVERIES) {
          valid.splice(0, valid.length - MAX_DELIVERIES);
        }
        window.localStorage.setItem(storageKey, JSON.stringify(valid));
      } catch {}
    }

    deliver();
    return "claimed";
  }
}

export const browserNotificationDelivery = new BrowserNotificationDelivery();

// ============================================================================
// Surface Detection & Permissions
// ============================================================================

export function isTauriDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "__TAURI_INTERNALS__" in window ||
    "__TAURI_INTERNals__" in window ||
    "__TAURI__" in window ||
    (window as any).__AMIRO_DESKTOP__ === true
  );
}

export function isNotificationsSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (isTauriDesktop()) return true;
  return "Notification" in window;
}

export function checkBrowserPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined") return "unsupported";
  if (isTauriDesktop()) return "granted";
  const NotificationObj = window.Notification || (globalThis as any).Notification;
  if (!NotificationObj) return "unsupported";
  return NotificationObj.permission || "default";
}

export async function requestBrowserNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof window === "undefined") return "unsupported";
  if (isTauriDesktop()) return "granted";
  if (!("Notification" in window)) return "unsupported";
  try {
    const result = await window.Notification.requestPermission();
    return result;
  } catch {
    return checkBrowserPermission();
  }
}

let serviceWorkerRegistered = false;

export async function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  if (serviceWorkerRegistered) {
    try {
      return await navigator.serviceWorker.ready;
    } catch {
      return null;
    }
  }
  try {
    const reg = await navigator.serviceWorker.register("/amiro-notifications-sw.js", {
      scope: "/",
    });
    serviceWorkerRegistered = true;
    return reg;
  } catch {
    return null;
  }
}

// ============================================================================
// Navigation & Window Focus
// ============================================================================

export function focusWindow(): void {
  if (typeof window === "undefined") return;
  try {
    window.focus?.();
  } catch {}

  const w = window as any;
  if (typeof w.__TAURI__?.core?.invoke === "function") {
    try {
      void w.__TAURI__.core.invoke("focus_main_window");
      return;
    } catch {}
  }
  if (typeof w.__TAURI__?.invoke === "function") {
    try {
      void w.__TAURI__.invoke("focus_main_window");
    } catch {}
  }
}

export function navigateToDeepLinkTarget(
  target: NotificationDeepLinkTarget | null | undefined,
): void {
  const resolved = resolveDeepLinkTarget({
    deepLinkTarget: target ?? null,
    threadId: null,
    scheduleId: null,
  });
  navigateToThreadOrSchedule(
    resolved?.threadId,
    resolved?.scheduleId,
  );
}

export function navigateToThreadOrSchedule(
  threadId: string | null | undefined,
  scheduleId: string | null | undefined,
): void {
  if (typeof window === "undefined") return;
  focusWindow();
  if (threadId) {
    const target = buildThreadUrl(threadId);
    if (window.location.pathname === "/" && window.location.search.includes(`thread=${encodeURIComponent(threadId)}`)) {
      return;
    }
    window.location.href = target;
    return;
  }
  if (scheduleId) {
    const target = buildScheduleUrl(scheduleId);
    window.location.href = target;
    return;
  }
  window.location.href = "/";
}

let clickListenersInitialized = false;

export function setupNotificationClickListeners(): void {
  if (typeof window === "undefined" || clickListenersInitialized) return;
  clickListenersInitialized = true;

  window.addEventListener("amiro:notification-click", (event: Event) => {
    const custom = event as CustomEvent;
    const detail = custom.detail || {};
    // Phase 02: clicks route via the intent's deepLinkTarget, falling back
    // to the legacy flat thread/schedule ids.
    navigateToDeepLinkTarget(
      resolveDeepLinkTarget({
        deepLinkTarget: parseDeepLinkTarget(detail.deepLinkTarget),
        threadId: detail.threadId,
        scheduleId: detail.scheduleId,
      }),
    );
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data;
      if (data?.type === "amiro:notification-click") {
        navigateToDeepLinkTarget(
          resolveDeepLinkTarget({
            deepLinkTarget: parseDeepLinkTarget(data.deepLinkTarget),
            threadId: data.threadId,
            scheduleId: data.scheduleId,
          }),
        );
      }
    });
  }
}

// ============================================================================
// Quiet Hours & Focused Suppression
// ============================================================================

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function isQuietHours(settings: NotificationSettings): boolean {
  if (!settings.quietHoursEnabled) return false;
  const start = parseTime(settings.quietStart);
  const end = parseTime(settings.quietEnd);
  if (!start || !end) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

export function shouldSuppressFocusedNotificationDelivery(
  notification: Pick<AmiroNotification, "threadId" | "deliveryId">,
  currentThreadId: string | null | undefined,
): boolean {
  const doc = typeof document !== "undefined" ? document : (window as any)?.document;
  if (!doc) return false;
  if (!notification.threadId || notification.threadId !== currentThreadId) {
    return false;
  }
  if (doc.visibilityState !== "visible") return false;
  return doc.hasFocus?.() ?? true;
}

// ============================================================================
// Audio Chime
// ============================================================================

let audioContextRef: AudioContext | null = null;

export function playNotificationChime(): void {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    if (!audioContextRef || audioContextRef.state === "closed") {
      audioContextRef = new AudioCtx();
    }
    const ctx = audioContextRef;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(523.25, t); // C5
    osc.frequency.exponentialRampToValueAtTime(659.25, t + 0.06); // E5
    osc.frequency.exponentialRampToValueAtTime(523.25, t + 0.2);

    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.09, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + 0.32);
  } catch {}
}

// ============================================================================
// Surface 1: Desktop App (Tauri Native Bridge)
// ============================================================================

export async function showDesktopNotification(
  payload: NotificationDeliveryPayload,
): Promise<boolean> {
  if (typeof window === "undefined") return false;

  if (typeof window.__AMIRO_DESKTOP_NOTIFY__ === "function") {
    try {
      await window.__AMIRO_DESKTOP_NOTIFY__(payload);
      return true;
    } catch {}
  }

  const w = window as any;
  const invoke = w.__TAURI__?.core?.invoke || w.__TAURI__?.invoke;
  if (typeof invoke === "function") {
    try {
      await invoke("desktop_show_notification", { ...payload });
      return true;
    } catch {}
  }

  return showBrowserNotification(payload);
}

// ============================================================================
// Surface 2: Web Browser Notification API + Service Worker
// ============================================================================

export function showBrowserNotification(
  payload: NotificationDeliveryPayload,
): boolean {
  if (typeof window === "undefined") return false;
  if (!isNotificationsSupported()) return false;
  if (checkBrowserPermission() !== "granted") return false;

  const title = payload.title;
  const deepLinkTarget = resolveDeepLinkTarget({
    deepLinkTarget: payload.deepLinkTarget ?? null,
    threadId: payload.threadId,
    scheduleId: payload.scheduleId,
  });
  const options: NotificationOptions = {
    body: payload.preview || payload.body,
    tag: payload.deliveryId,
    icon: payload.icon || "/favicon.ico",
    data: {
      threadId: payload.threadId,
      scheduleId: payload.scheduleId,
      deepLinkTarget,
      notificationId: payload.notificationId,
    },
  };

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try {
      void navigator.serviceWorker.ready.then((reg) => {
        if (reg && typeof reg.showNotification === "function") {
          return reg.showNotification(title, options);
        }
      }).catch(() => {});
    } catch {}
  }

  try {
    if (typeof window.Notification === "function") {
      const notification = new window.Notification(title, options);
      notification.onclick = () => {
        focusWindow();
        navigateToDeepLinkTarget(deepLinkTarget);
        notification.close();
      };
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

// ============================================================================
// Surface 3: In-App Toast Fallback (Sonner)
// ============================================================================

export function showInAppToast(
  payload: NotificationDeliveryPayload,
  onClick?: () => void,
): string {
  const toastId = toast(payload.title, {
    description: payload.preview || payload.body,
    duration: 6000,
    action: {
      label: "View",
      onClick: () => {
        onClick?.();
        navigateToDeepLinkTarget(
          resolveDeepLinkTarget({
            deepLinkTarget: payload.deepLinkTarget ?? null,
            threadId: payload.threadId,
            scheduleId: payload.scheduleId,
          }),
        );
      },
    },
    icon: "🔔",
  });
  return String(toastId);
}

// ============================================================================
// Delivery Pipeline
// ============================================================================

export interface DeliverNotificationOptions {
  currentThreadId?: string | null;
  settings?: NotificationSettings;
  soundEnabled?: boolean;
  suppressInAppToast?: boolean;
}

export function isCategoryEnabled(
  category: NotificationCategory,
  settings: NotificationSettings,
): boolean {
  if (!settings.enabled) return false;
  switch (category) {
    case "chat_reply":
      return settings.chatReplyAlerts;
    case "schedule_result":
      return settings.scheduleAlerts;
    case "heartbeat":
      return settings.heartbeatAlerts;
    case "approval":
    case "system":
      return true;
    default:
      return true;
  }
}

export async function deliverNotification(
  payload: NotificationDeliveryPayload,
  options: DeliverNotificationOptions = {},
): Promise<NotificationReceiptClass | null> {
  const settings = options.settings ?? getCachedNotificationSettings();

  if (!settings.enabled) {
    return null;
  }

  if (!isCategoryEnabled(payload.category, settings)) {
    return null;
  }

  if (isQuietHours(settings)) {
    if (!options.suppressInAppToast) {
      showInAppToast(payload);
    }
    void ackNotificationDelivery(payload.notificationId, "in_app_toast", true).catch(() => {});
    return "in_app_toast";
  }

  if (hasRecentlyDelivered(payload.deliveryId)) {
    return null;
  }
  recordDelivery(payload.deliveryId);

  const convKey = browserNotificationConversationKey(payload.threadId);
  const claimed = await browserNotificationDelivery.post(
    payload.deliveryId,
    () => {},
    () => true,
    convKey,
  );
  if (claimed === "duplicate") {
    return null;
  }

  const isFocusedThread = shouldSuppressFocusedNotificationDelivery(
    payload,
    options.currentThreadId,
  );

  if (isFocusedThread) {
    if (payload.silent) {
      return null;
    }
    const soundAllowed = options.soundEnabled ?? settings.soundEnabled;
    if (soundAllowed) {
      playNotificationChime();
    }
    if (!options.suppressInAppToast) {
      showInAppToast(payload);
    }
    void ackNotificationDelivery(payload.notificationId, "in_app_toast", true).catch(() => {});
    return "in_app_toast";
  }

  const soundAllowed = options.soundEnabled ?? settings.soundEnabled;

  const desktopRequested = settings.desktopBannerEnabled && isTauriDesktop();
  if (desktopRequested) {
    const delivered = await showDesktopNotification(payload);
    if (delivered) {
      if (soundAllowed) {
        playNotificationChime();
      }
      if (!options.suppressInAppToast) {
        showInAppToast(payload);
      }
      void ackNotificationDelivery(payload.notificationId, "desktop_native", true).catch(() => {});
      return "desktop_native";
    }
  }

  const browserPerm = checkBrowserPermission();
  const browserRequested =
    settings.webPushEnabled &&
    (settings.allAlertsEnabled ||
      payload.category === "approval" ||
      payload.category === "chat_reply" ||
      payload.category === "schedule_result");

  if (browserRequested && browserPerm === "granted") {
    const delivered = showBrowserNotification(payload);
    if (delivered) {
      if (soundAllowed) {
        playNotificationChime();
      }
      if (!options.suppressInAppToast) {
        showInAppToast(payload);
      }
      void ackNotificationDelivery(payload.notificationId, "web_notification", true).catch(() => {});
      return "web_notification";
    }
  }

  if (!options.suppressInAppToast) {
    if (soundAllowed) {
      playNotificationChime();
    }
    showInAppToast(payload);
    void ackNotificationDelivery(payload.notificationId, "in_app_toast", true).catch(() => {});
    return "in_app_toast";
  }

  return null;
}

export function notificationToDeliveryPayload(
  notification: AmiroNotification,
): NotificationDeliveryPayload {
  return {
    deliveryId: notification.deliveryId,
    notificationId: notification.id,
    category: notification.category,
    urgency: notification.urgency,
    title: notification.title,
    body: notification.body,
    preview: notification.preview,
    silent: notification.silent,
    threadId: notification.threadId,
    scheduleId: notification.scheduleId,
    deepLinkTarget: notification.deepLinkTarget ?? null,
    icon: "/favicon.ico",
    data: notification.data,
  };
}

export async function deliverAmiroNotification(
  notification: AmiroNotification,
  options: DeliverNotificationOptions = {},
): Promise<NotificationReceiptClass | null> {
  return deliverNotification(notificationToDeliveryPayload(notification), options);
}

export interface CompletionNotificationPayload {
  threadId: string;
  title?: string;
  message?: string;
}

export function emitCompletionNotification(
  payload: CompletionNotificationPayload,
  options: Omit<DeliverNotificationOptions, "currentThreadId"> = {},
): Promise<NotificationReceiptClass | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const currentThreadId =
    typeof appStore?.getState === "function"
      ? appStore.getState()?.currentThreadId
      : null;
  const deliveryId = `completion-${payload.threadId}-${Date.now()}`;
  const deliveryPayload: NotificationDeliveryPayload = {
    deliveryId,
    notificationId: deliveryId,
    category: "chat_reply",
    title: payload.title || "Chat turn completed",
    body:
      payload.message ||
      "A background chat turn or scheduled run has finished.",
    threadId: payload.threadId,
    icon: "/favicon.ico",
  };
  return deliverNotification(deliveryPayload, {
    ...options,
    currentThreadId,
  });
}

// ============================================================================
// Real-Time Event Hub & SWR Hooks
// ============================================================================

type NotificationListener = (notification: AmiroNotification) => void;
const listeners = new Set<NotificationListener>();

export function onNotificationReceived(listener: NotificationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitNotificationReceived(notification: AmiroNotification): void {
  listeners.forEach((l) => l(notification));
}

export interface UseNotificationsResult {
  notifications: AmiroNotification[];
  unreadCount: number;
  isLoading: boolean;
  error: Error | undefined;
  mutate: ReturnType<typeof useSWR<AmiroNotification[]>>["mutate"];
}

export function useNotifications(): UseNotificationsResult {
  const {
    data: notifications = [],
    error,
    isLoading,
    mutate,
  } = useSWR<AmiroNotification[]>(
    NOTIFICATIONS_LIST_KEY,
    fetchNotifications,
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
      dedupingInterval: 2000,
    },
  );

  useEffect(() => {
    return onNotificationReceived((incoming) => {
      mutate(
        (current) => {
          if (!current) return [incoming];
          const filtered = current.filter((n) => n.id !== incoming.id);
          return [incoming, ...filtered];
        },
        { revalidate: false },
      );
    });
  }, [mutate]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read && !n.dismissed).length,
    [notifications],
  );

  return {
    notifications,
    unreadCount,
    isLoading,
    error,
    mutate,
  };
}

export function useNotificationStream(): void {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    void registerNotificationServiceWorker();
    setupNotificationClickListeners();

    const unsubscribeAttention = browserNotificationDelivery.trackAttention(() => {
      const threadId = appStore.getState().currentThreadId;
      return browserNotificationConversationKey(threadId);
    });

    if (!window.EventSource) {
      return () => {
        unsubscribeAttention();
      };
    }

    let mounted = true;

    const connect = () => {
      if (!mounted) return;
      if (eventSourceRef.current) return;

      const token = getSessionToken() || getBackendSharedSecret();
      const base = backendUrl(NOTIFICATIONS_STREAM_PATH);
      const url = new URL(base, window.location.origin);
      if (token) {
        url.searchParams.set("token", token);
      }

      const es = new EventSource(url.toString());
      eventSourceRef.current = es;

      const handlePayload = (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const obj = raw as Record<string, unknown>;

        if (obj.type === "notification_intent" || obj.notification) {
          const notification = parseNotification(obj.notification ?? obj);
          if (notification) {
            // Phase 02: the intent envelope carries the canonical deliveryId
            // and deepLinkTarget; the item already has them, but the envelope
            // wins when both are present.
            if (
              typeof obj.deliveryId === "string" &&
              obj.deliveryId.length > 0
            ) {
              notification.deliveryId = obj.deliveryId;
            }
            const target = parseDeepLinkTarget(obj.deepLinkTarget);
            if (target) {
              notification.deepLinkTarget = target;
            }
            emitNotificationReceived(notification);
            const currentThreadId = appStore.getState().currentThreadId;
            const settings = getCachedNotificationSettings();
            void deliverAmiroNotification(notification, {
              currentThreadId,
              settings,
            });
            void globalMutate(NOTIFICATIONS_LIST_KEY);
          }
        } else if (obj.type === "notifications_updated") {
          void globalMutate(NOTIFICATIONS_LIST_KEY);
        } else if (obj.type === "snapshot") {
          void globalMutate(NOTIFICATIONS_LIST_KEY);
        }
      };

      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          handlePayload(parsed);
        } catch {}
      };

      es.addEventListener("notification", (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent).data);
          handlePayload(parsed);
        } catch {}
      });

      es.addEventListener("notifications_updated", () => {
        void globalMutate(NOTIFICATIONS_LIST_KEY);
      });

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        if (mounted) {
          reconnectTimeoutRef.current = setTimeout(connect, 5000);
        }
      };
    };

    connect();

    return () => {
      mounted = false;
      unsubscribeAttention();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);
}
