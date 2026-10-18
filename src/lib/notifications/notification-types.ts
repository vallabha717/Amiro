import { apiJson } from "@/lib/backend/client";

export type NotificationCategory =
  | "chat_reply"
  | "schedule_result"
  | "heartbeat"
  | "approval"
  | "system";

export type NotificationUrgency = "low" | "normal" | "high" | "critical";

export type NotificationStatus = "new" | "seen" | "acted_on" | "dismissed";

export type NotificationReceiptClass =
  | "desktop_native"
  | "web_notification"
  | "in_app_toast"
  | "client_os_posted";

export interface NotificationReceipt {
  receiptClass: NotificationReceiptClass;
  deliveredAt: string;
}

export interface NotificationAction {
  id: string;
  label: string;
}

export interface AmiroNotification {
  id: string;
  deliveryId: string;
  userId?: string;
  category: NotificationCategory;
  urgency?: NotificationUrgency;
  status: NotificationStatus;
  title: string;
  body: string;
  summary?: string;
  preview?: string;
  silent?: boolean;
  threadId?: string | null;
  scheduleId?: string | null;
  sourceEventName?: string;
  actions?: NotificationAction[];
  read: boolean;
  dismissed: boolean;
  createdAt: string;
  updatedAt?: string;
  ackedAt?: string | null;
  deliveryReceipt?: NotificationReceiptClass | string | null;
  data?: Record<string, unknown>;
  receipts?: NotificationReceipt[];
}

export interface NotificationDeliveryPayload {
  deliveryId: string;
  notificationId: string;
  category: NotificationCategory;
  urgency?: NotificationUrgency;
  title: string;
  body: string;
  preview?: string;
  silent?: boolean;
  threadId?: string | null;
  scheduleId?: string | null;
  icon?: string;
  data?: Record<string, unknown>;
}

export interface NotificationSettings {
  enabled: boolean;
  allAlertsEnabled: boolean;
  chatReplyAlerts: boolean;
  scheduleAlerts: boolean;
  heartbeatAlerts: boolean;
  soundEnabled: boolean;
  desktopBannerEnabled: boolean;
  webPushEnabled: boolean;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  // Compatibility aliases
  notificationsEnabled?: boolean;
  allAlertsBannerMode?: boolean;
  scheduleRunAndReminderAlerts?: boolean;
  notificationSoundChime?: boolean;
  desktopNativeOsBanners?: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  allAlertsEnabled: true,
  chatReplyAlerts: true,
  scheduleAlerts: true,
  heartbeatAlerts: true,
  soundEnabled: true,
  desktopBannerEnabled: true,
  webPushEnabled: true,
  quietHoursEnabled: false,
  quietStart: "22:00",
  quietEnd: "08:00",
  // Aliases
  notificationsEnabled: true,
  allAlertsBannerMode: true,
  scheduleRunAndReminderAlerts: true,
  notificationSoundChime: true,
  desktopNativeOsBanners: true,
};

export interface NotificationsFeedResponse {
  version: number;
  items: AmiroNotification[];
  unreadCount: number;
  updatedAt: string;
  settings: NotificationSettings;
}

export interface NotificationsSettingsResponse {
  settings?: NotificationSettings;
  enabled?: boolean;
  allAlertsEnabled?: boolean;
  [key: string]: unknown;
}

export interface UpdateNotificationsSettingsPayload {
  enabled?: boolean;
  allAlertsEnabled?: boolean;
  chatReplyAlerts?: boolean;
  scheduleAlerts?: boolean;
  heartbeatAlerts?: boolean;
  soundEnabled?: boolean;
  desktopBannerEnabled?: boolean;
  webPushEnabled?: boolean;
  quietHoursEnabled?: boolean;
  quietStart?: string;
  quietEnd?: string;
  // Aliases
  notificationsEnabled?: boolean;
  allAlertsBannerMode?: boolean;
  scheduleRunAndReminderAlerts?: boolean;
  notificationSoundChime?: boolean;
  desktopNativeOsBanners?: boolean;
}

export const NOTIFICATIONS_API_PATH = "/api/notifications";
export const NOTIFICATIONS_SETTINGS_PATH = "/api/notifications/settings";
export const NOTIFICATIONS_STREAM_PATH = "/api/notifications/stream";
export const NOTIFICATIONS_LIST_KEY = "/api/notifications";
export const NOTIFICATION_SETTINGS_KEY = "/api/notifications/settings";
export const NOTIFICATIONS_STORAGE_KEY = "amiro.notifications.settings.v1";

export function categoryLabel(category: NotificationCategory): string {
  switch (category) {
    case "chat_reply":
      return "Chat reply";
    case "schedule_result":
      return "Schedule";
    case "heartbeat":
      return "Heartbeat";
    case "approval":
      return "Approval";
    case "system":
      return "System";
    default:
      return "Notification";
  }
}

export function isNotificationCategory(
  value: unknown,
): value is NotificationCategory {
  return (
    typeof value === "string" &&
    [
      "chat_reply",
      "schedule_result",
      "heartbeat",
      "approval",
      "system",
    ].includes(value)
  );
}

export function buildThreadUrl(threadId: string): string {
  return `/?thread=${encodeURIComponent(threadId)}`;
}

export function buildScheduleUrl(scheduleId?: string | null): string {
  return scheduleId ? `/schedules?id=${encodeURIComponent(scheduleId)}` : "/schedules";
}

export function parseNotification(payload: unknown): AmiroNotification | null {
  if (!payload || typeof payload !== "object") return null;
  const n = payload as Record<string, unknown>;
  const rawId = (n.id || n.deliveryId || n.notificationId) as string | undefined;
  if (!rawId || typeof rawId !== "string") return null;

  const id = rawId;
  const deliveryId = typeof n.deliveryId === "string" ? n.deliveryId : id;
  const title = typeof n.title === "string" ? n.title : "Notification";
  const bodyText =
    typeof n.body === "string"
      ? n.body
      : typeof n.summary === "string"
        ? n.summary
        : title;
  const summary = typeof n.summary === "string" ? n.summary : bodyText;
  const preview = typeof n.preview === "string" ? n.preview : summary;

  const rawStatus = typeof n.status === "string" ? n.status : undefined;
  const explicitRead = typeof n.read === "boolean" ? n.read : undefined;
  const explicitDismissed = typeof n.dismissed === "boolean" ? n.dismissed : undefined;

  const status: NotificationStatus =
    rawStatus === "dismissed" || explicitDismissed === true
      ? "dismissed"
      : rawStatus === "seen" || rawStatus === "acted_on" || explicitRead === true
        ? "seen"
        : "new";

  const read = status !== "new";
  const dismissed = status === "dismissed";

  return {
    id,
    deliveryId,
    userId: typeof n.userId === "string" ? n.userId : undefined,
    category: isNotificationCategory(n.category) ? n.category : "system",
    urgency: (typeof n.urgency === "string" ? n.urgency : "normal") as NotificationUrgency,
    status,
    title,
    body: bodyText,
    summary,
    preview,
    silent: Boolean(n.silent),
    threadId: typeof n.threadId === "string" ? n.threadId : null,
    scheduleId: typeof n.scheduleId === "string" ? n.scheduleId : null,
    sourceEventName: typeof n.sourceEventName === "string" ? n.sourceEventName : undefined,
    actions: Array.isArray(n.actions) ? (n.actions as NotificationAction[]) : undefined,
    read,
    dismissed,
    createdAt: typeof n.createdAt === "string" ? n.createdAt : new Date().toISOString(),
    updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : undefined,
    ackedAt: typeof n.ackedAt === "string" ? n.ackedAt : null,
    deliveryReceipt:
      typeof n.deliveryReceipt === "string"
        ? (n.deliveryReceipt as NotificationReceiptClass)
        : null,
    data: n.data && typeof n.data === "object" ? (n.data as Record<string, unknown>) : undefined,
    receipts: Array.isArray(n.receipts) ? (n.receipts as NotificationReceipt[]) : undefined,
  };
}

export function normalizeSettings(raw: unknown): NotificationSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_NOTIFICATION_SETTINGS };
  const r = raw as Record<string, unknown>;
  const enabled =
    r.enabled === false || r.notificationsEnabled === false
      ? false
      : typeof r.enabled === "boolean"
        ? r.enabled
        : typeof r.notificationsEnabled === "boolean"
          ? r.notificationsEnabled
          : DEFAULT_NOTIFICATION_SETTINGS.enabled;

  const allAlertsEnabled =
    r.allAlertsEnabled === false || r.allAlertsBannerMode === false
      ? false
      : typeof r.allAlertsEnabled === "boolean"
        ? r.allAlertsEnabled
        : typeof r.allAlertsBannerMode === "boolean"
          ? r.allAlertsBannerMode
          : DEFAULT_NOTIFICATION_SETTINGS.allAlertsEnabled;

  const chatReplyAlerts =
    typeof r.chatReplyAlerts === "boolean"
      ? r.chatReplyAlerts
      : DEFAULT_NOTIFICATION_SETTINGS.chatReplyAlerts;

  const scheduleAlerts =
    r.scheduleAlerts === false || r.scheduleRunAndReminderAlerts === false
      ? false
      : typeof r.scheduleAlerts === "boolean"
        ? r.scheduleAlerts
        : typeof r.scheduleRunAndReminderAlerts === "boolean"
          ? r.scheduleRunAndReminderAlerts
          : DEFAULT_NOTIFICATION_SETTINGS.scheduleAlerts;

  const heartbeatAlerts =
    typeof r.heartbeatAlerts === "boolean"
      ? r.heartbeatAlerts
      : DEFAULT_NOTIFICATION_SETTINGS.heartbeatAlerts;

  const soundEnabled =
    r.soundEnabled === false || r.notificationSoundChime === false
      ? false
      : typeof r.soundEnabled === "boolean"
        ? r.soundEnabled
        : typeof r.notificationSoundChime === "boolean"
          ? r.notificationSoundChime
          : DEFAULT_NOTIFICATION_SETTINGS.soundEnabled;

  const desktopBannerEnabled =
    r.desktopBannerEnabled === false || r.desktopNativeOsBanners === false
      ? false
      : typeof r.desktopBannerEnabled === "boolean"
        ? r.desktopBannerEnabled
        : typeof r.desktopNativeOsBanners === "boolean"
          ? r.desktopNativeOsBanners
          : DEFAULT_NOTIFICATION_SETTINGS.desktopBannerEnabled;

  const webPushEnabled =
    typeof r.webPushEnabled === "boolean"
      ? r.webPushEnabled
      : DEFAULT_NOTIFICATION_SETTINGS.webPushEnabled;

  const quietHoursEnabled =
    typeof r.quietHoursEnabled === "boolean"
      ? r.quietHoursEnabled
      : DEFAULT_NOTIFICATION_SETTINGS.quietHoursEnabled;

  const quietStart =
    typeof r.quietStart === "string" && r.quietStart.trim()
      ? r.quietStart.trim()
      : DEFAULT_NOTIFICATION_SETTINGS.quietStart;

  const quietEnd =
    typeof r.quietEnd === "string" && r.quietEnd.trim()
      ? r.quietEnd.trim()
      : DEFAULT_NOTIFICATION_SETTINGS.quietEnd;

  return {
    enabled,
    allAlertsEnabled,
    chatReplyAlerts,
    scheduleAlerts,
    heartbeatAlerts,
    soundEnabled,
    desktopBannerEnabled,
    webPushEnabled,
    quietHoursEnabled,
    quietStart,
    quietEnd,
    // Aliases
    notificationsEnabled: enabled,
    allAlertsBannerMode: allAlertsEnabled,
    scheduleRunAndReminderAlerts: scheduleAlerts,
    notificationSoundChime: soundEnabled,
    desktopNativeOsBanners: desktopBannerEnabled,
  };
}

export function getCachedNotificationSettings(): NotificationSettings {
  if (typeof window === "undefined") {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!raw) return DEFAULT_NOTIFICATION_SETTINGS;
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

export function setCachedNotificationSettings(settings: NotificationSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // ignore quota/storage errors
  }
}

export async function fetchNotificationSettings(): Promise<NotificationSettings> {
  try {
    const data = await apiJson<NotificationsSettingsResponse>(NOTIFICATIONS_SETTINGS_PATH);
    if (data) {
      const normalized = normalizeSettings(data.settings ?? data);
      setCachedNotificationSettings(normalized);
      return normalized;
    }
  } catch {
    // Backend offline or route pending: fall back to local cache
  }
  return getCachedNotificationSettings();
}

export async function updateNotificationSettings(
  payload: UpdateNotificationsSettingsPayload,
): Promise<NotificationSettings> {
  const current = getCachedNotificationSettings();
  const next = normalizeSettings({ ...current, ...payload });
  setCachedNotificationSettings(next);

  try {
    const body: Record<string, unknown> = {
      enabled: next.enabled,
      allAlertsEnabled: next.allAlertsEnabled,
      chatReplyAlerts: next.chatReplyAlerts,
      scheduleAlerts: next.scheduleAlerts,
      heartbeatAlerts: next.heartbeatAlerts,
      soundEnabled: next.soundEnabled,
      desktopBannerEnabled: next.desktopBannerEnabled,
      webPushEnabled: next.webPushEnabled,
      quietHoursEnabled: next.quietHoursEnabled,
      quietStart: next.quietStart,
      quietEnd: next.quietEnd,
    };

    const data = await apiJson<NotificationsSettingsResponse>(NOTIFICATIONS_SETTINGS_PATH, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (data) {
      const normalized = normalizeSettings(data.settings ?? data);
      setCachedNotificationSettings(normalized);
      return normalized;
    }
  } catch {
    // Retain optimistic cache on backend offline
  }

  return next;
}

export async function fetchNotificationsFeed(options: {
  unreadOnly?: boolean;
  includeDismissed?: boolean;
} = {}): Promise<NotificationsFeedResponse> {
  const query = new URLSearchParams();
  if (options.unreadOnly) query.set("unreadOnly", "true");
  if (options.includeDismissed) query.set("includeDismissed", "true");
  const qs = query.toString();
  const path = qs ? `${NOTIFICATIONS_API_PATH}?${qs}` : NOTIFICATIONS_API_PATH;

  const data = await apiJson<{
    version?: number;
    items?: unknown[];
    unreadCount?: number;
    updatedAt?: string;
    settings?: unknown;
  }>(path);

  const rawItems = Array.isArray(data?.items) ? data.items : [];
  const items = rawItems
    .map(parseNotification)
    .filter((n): n is AmiroNotification => n !== null);

  const unreadCount =
    typeof data?.unreadCount === "number"
      ? data.unreadCount
      : items.filter((n) => !n.read && !n.dismissed).length;

  const settings = normalizeSettings(data?.settings);

  return {
    version: data?.version ?? 2,
    items,
    unreadCount,
    updatedAt: data?.updatedAt ?? new Date().toISOString(),
    settings,
  };
}

export async function fetchNotifications(options: {
  unreadOnly?: boolean;
  includeDismissed?: boolean;
} = {}): Promise<AmiroNotification[]> {
  const feed = await fetchNotificationsFeed(options);
  return feed.items;
}

export async function ackNotificationDelivery(
  notificationId: string,
  receiptClass: NotificationReceiptClass,
  delivered = true,
): Promise<void> {
  await apiJson(`${NOTIFICATIONS_API_PATH}/${encodeURIComponent(notificationId)}/ack`, {
    method: "POST",
    body: JSON.stringify({ delivered, receiptClass }),
  });
}

export async function markNotificationRead(
  notificationId: string,
  read = true,
): Promise<void> {
  await apiJson(`${NOTIFICATIONS_API_PATH}/${encodeURIComponent(notificationId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: read ? "seen" : "new" }),
  });
}

export async function markAllNotificationsRead(): Promise<{ marked: number; unreadCount: number }> {
  return await apiJson<{ marked: number; unreadCount: number }>(
    `${NOTIFICATIONS_API_PATH}/mark-all-read`,
    {
      method: "POST",
    },
  );
}

export async function clearAllNotifications(): Promise<{ cleared: number; unreadCount: number }> {
  return await apiJson<{ cleared: number; unreadCount: number }>(
    `${NOTIFICATIONS_API_PATH}/clear-all`,
    {
      method: "POST",
    },
  );
}

export async function dismissNotification(notificationId: string): Promise<void> {
  await apiJson(`${NOTIFICATIONS_API_PATH}/${encodeURIComponent(notificationId)}`, {
    method: "DELETE",
  });
}

export async function sendTestNotification(): Promise<{
  item: AmiroNotification;
  unreadCount: number;
}> {
  const result = await apiJson<{ item: unknown; unreadCount: number }>(
    `${NOTIFICATIONS_API_PATH}/test`,
    {
      method: "POST",
    },
  );
  const parsed = parseNotification(result.item);
  return {
    item: parsed ?? {
      id: "test",
      deliveryId: "test",
      category: "system",
      status: "new",
      title: "Amiro Test Notification",
      body: "Notifications are working across Web UI and Desktop.",
      read: false,
      dismissed: false,
      createdAt: new Date().toISOString(),
    },
    unreadCount: result.unreadCount ?? 1,
  };
}
