import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Minimal browser environment polyfill for Node-based Vitest runs.
const mockStorage: Record<string, string> = {};
const mockWindow = {
  localStorage: {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
    clear: () => {
      Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    },
    key: (index: number) => Object.keys(mockStorage)[index] ?? null,
    get length() {
      return Object.keys(mockStorage).length;
    },
  },
  document: {
    visibilityState: "visible",
    hasFocus: () => true,
  },
  location: { href: "" },
  focus: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  EventSource: class MockEventSource {
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    close = vi.fn();
  },
  AudioContext: class MockAudioContext {
    currentTime = 0;
    state = "running";
    resume = vi.fn().mockResolvedValue(undefined);
    createOscillator = () => ({
      type: "",
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    });
    createGain = () => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    });
    destination = {};
  },
};

(globalThis as any).window = mockWindow;
(globalThis as any).document = mockWindow.document;
Object.defineProperty(globalThis, "navigator", {
  value: { serviceWorker: undefined },
  configurable: true,
  writable: true,
});

vi.mock("@/lib/backend/client", () => ({
  apiJson: vi.fn().mockResolvedValue({}),
  apiFetch: vi.fn().mockResolvedValue(new Response()),
}));

vi.mock("sonner", () => {
  const toastMock = vi.fn().mockReturnValue("toast-id");
  return {
    toast: toastMock,
    default: toastMock,
  };
});

vi.mock("@/app/store", () => ({
  appStore: {
    getState: vi.fn().mockReturnValue({ currentThreadId: null }),
  },
}));

vi.mock("@/lib/backend/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend/config")>(
    "@/lib/backend/config",
  );
  return {
    ...actual,
    getSessionToken: vi.fn().mockReturnValue("test-token"),
    getBackendSharedSecret: vi.fn().mockReturnValue("test-secret"),
    backendUrl: (path: string) => `http://localhost:8787${path}`,
  };
});

import { toast } from "sonner";
import {
  isTauriDesktop,
  isNotificationsSupported,
  checkBrowserPermission,
  requestBrowserNotificationPermission,
  hasRecentlyDelivered,
  recordDelivery,
  isQuietHours,
  shouldSuppressFocusedNotificationDelivery,
  showBrowserNotification,
  showDesktopNotification,
  showInAppToast,
  deliverNotification,
  notificationToDeliveryPayload,
  navigateToThreadOrSchedule,
  emitCompletionNotification,
  browserNotificationDelivery,
  playNotificationChime,
} from "./notification-runtime";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATIONS_STORAGE_KEY,
  type NotificationDeliveryPayload,
} from "./notification-types";

const basePayload: NotificationDeliveryPayload = {
  deliveryId: "del-1",
  notificationId: "notif-1",
  category: "chat_reply",
  title: "Hello",
  body: "A chat reply has arrived.",
  preview: "A chat reply...",
  threadId: "thread-1",
  icon: "/favicon.ico",
};

function resetLocalStorage() {
  try {
    window.localStorage.clear();
  } catch {}
}

beforeEach(() => {
  resetLocalStorage();
  browserNotificationDelivery.resetForTests();
  window.Notification = {
    permission: "default",
    requestPermission: vi.fn().mockResolvedValue("granted"),
  } as unknown as typeof window.Notification;
  (globalThis as any).Notification = window.Notification;
  (globalThis as any).document = window.document;

  delete (window as any).__TAURI__;
  delete (window as any).__TAURI_INTERNals__;
  delete (window as any).__TAURI_INTERNALS__;
  delete (window as any).__AMIRO_DESKTOP__;
  delete (window as any).__AMIRO_DESKTOP_NOTIFY__;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("platform detection", () => {
  it("detects Tauri desktop from __TAURI__", () => {
    expect(isTauriDesktop()).toBe(false);
    (window as any).__TAURI__ = {};
    expect(isTauriDesktop()).toBe(true);
  });

  it("detects Tauri desktop from __AMIRO_DESKTOP__", () => {
    expect(isTauriDesktop()).toBe(false);
    (window as any).__AMIRO_DESKTOP__ = true;
    expect(isTauriDesktop()).toBe(true);
  });

  it("detects Tauri desktop from __TAURI_INTERNals__", () => {
    expect(isTauriDesktop()).toBe(false);
    (window as any).__TAURI_INTERNals__ = {};
    expect(isTauriDesktop()).toBe(true);
  });
});

describe("browser notification support", () => {
  it("reports supported when Notification is present", () => {
    expect(isNotificationsSupported()).toBe(true);
  });

  it("reports unsupported when Notification is missing", () => {
    const original = window.Notification;
    delete (window as any).Notification;
    delete (globalThis as any).Notification;
    expect(isNotificationsSupported()).toBe(false);
    window.Notification = original;
    (globalThis as any).Notification = original;
  });

  it("returns current permission", () => {
    (window.Notification as any).permission = "granted";
    expect(checkBrowserPermission()).toBe("granted");
  });

  it("requests permission and returns result", async () => {
    window.Notification.requestPermission = vi.fn().mockResolvedValue("granted");
    const result = await requestBrowserNotificationPermission();
    expect(result).toBe("granted");
    expect(window.Notification.requestPermission).toHaveBeenCalled();
  });
});

describe("delivery deduplication", () => {
  it("records and checks recent deliveries", () => {
    expect(hasRecentlyDelivered("del-1")).toBe(false);
    recordDelivery("del-1");
    expect(hasRecentlyDelivered("del-1")).toBe(true);
    expect(hasRecentlyDelivered("del-2")).toBe(false);
  });
});

describe("quiet hours", () => {
  it("returns false when quiet hours are disabled", () => {
    expect(
      isQuietHours({
        ...DEFAULT_NOTIFICATION_SETTINGS,
        quietHoursEnabled: false,
      }),
    ).toBe(false);
  });

  it("detects current time inside quiet window", () => {
    const now = new Date();
    const start = new Date(now.getTime() - 60000);
    const end = new Date(now.getTime() + 60000);
    const pad = (n: number) => n.toString().padStart(2, "0");
    expect(
      isQuietHours({
        ...DEFAULT_NOTIFICATION_SETTINGS,
        quietHoursEnabled: true,
        quietStart: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
        quietEnd: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
      }),
    ).toBe(true);
  });
});

describe("focused suppression", () => {
  it("suppresses when viewing the exact thread and visible", () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.hasFocus = vi.fn().mockReturnValue(true);
    expect(
      shouldSuppressFocusedNotificationDelivery(
        { threadId: "thread-1", deliveryId: "d1" },
        "thread-1",
      ),
    ).toBe(true);
  });

  it("does not suppress when thread differs", () => {
    expect(
      shouldSuppressFocusedNotificationDelivery(
        { threadId: "thread-1", deliveryId: "d1" },
        "thread-2",
      ),
    ).toBe(false);
  });

  it("does not suppress when tab is hidden", () => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    expect(
      shouldSuppressFocusedNotificationDelivery(
        { threadId: "thread-1", deliveryId: "d1" },
        "thread-1",
      ),
    ).toBe(false);
  });
});

describe("browser notification", () => {
  it("creates a Notification when permission is granted", () => {
    (window.Notification as any).permission = "granted";
    const close = vi.fn();
    const notificationCtor = vi.fn().mockImplementation(() => ({
      close,
      onclick: null,
    }));
    (notificationCtor as any).permission = "granted";
    window.Notification = notificationCtor as unknown as typeof window.Notification;

    const result = showBrowserNotification(basePayload);
    expect(result).toBe(true);
    expect(notificationCtor).toHaveBeenCalledWith("Hello", {
      body: "A chat reply...",
      tag: "del-1",
      icon: "/favicon.ico",
      data: { threadId: "thread-1", scheduleId: undefined, notificationId: "notif-1" },
    });
  });

  it("returns false when permission is denied", () => {
    (window.Notification as any).permission = "denied";
    expect(showBrowserNotification(basePayload)).toBe(false);
  });
});

describe("desktop notification", () => {
  it("uses __AMIRO_DESKTOP_NOTIFY__ bridge", async () => {
    const bridge = vi.fn().mockResolvedValue(undefined);
    (window as any).__AMIRO_DESKTOP_NOTIFY__ = bridge;
    const result = await showDesktopNotification(basePayload);
    expect(result).toBe(true);
    expect(bridge).toHaveBeenCalledWith(basePayload);
  });

  it("falls back to browser notification when bridge fails", async () => {
    (window as any).__AMIRO_DESKTOP_NOTIFY__ = vi.fn().mockRejectedValue(new Error("fail"));
    (window.Notification as any).permission = "granted";
    const notificationCtor = vi.fn().mockImplementation(() => ({
      close: vi.fn(),
      onclick: null,
    }));
    (notificationCtor as any).permission = "granted";
    window.Notification = notificationCtor as unknown as typeof window.Notification;

    const result = await showDesktopNotification(basePayload);
    expect(result).toBe(true);
    expect(notificationCtor).toHaveBeenCalled();
  });
});

describe("in-app toast", () => {
  it("calls sonner toast with a View action", () => {
    showInAppToast(basePayload);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "A chat reply...",
        duration: 6000,
      }),
    );
  });
});

describe("deliverNotification", () => {
  it("returns null when notifications are disabled", async () => {
    window.localStorage.setItem(
      NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, notificationsEnabled: false }),
    );
    const result = await deliverNotification(basePayload);
    expect(result).toBeNull();
  });

  it("delivers via in-app toast when browser permission is not granted", async () => {
    (window.Notification as any).permission = "default";
    const result = await deliverNotification(basePayload, {
      settings: DEFAULT_NOTIFICATION_SETTINGS,
    });
    expect(result).toBe("in_app_toast");
    expect(toast).toHaveBeenCalled();
  });

  it("delivers via web notification when permission is granted", async () => {
    (window.Notification as any).permission = "granted";
    const notificationCtor = vi.fn().mockImplementation(() => ({
      close: vi.fn(),
      onclick: null,
    }));
    (notificationCtor as any).permission = "granted";
    window.Notification = notificationCtor as unknown as typeof window.Notification;

    const result = await deliverNotification(basePayload, {
      settings: DEFAULT_NOTIFICATION_SETTINGS,
    });
    expect(result).toBe("web_notification");
  });
});

describe("navigation", () => {
  it("navigates to thread url", () => {
    const originalHref = window.location.href;
    delete (window as any).location;
    window.location = { href: "" } as any;
    navigateToThreadOrSchedule("thread-1", undefined);
    expect(window.location.href).toBe("/?thread=thread-1");
    window.location.href = originalHref;
  });
});

describe("notificationToDeliveryPayload", () => {
  it("maps an AmiroNotification to delivery payload", () => {
    const notification = {
      id: "n1",
      deliveryId: "d1",
      category: "chat_reply" as const,
      status: "new" as const,
      title: "Title",
      body: "Body",
      read: false,
      dismissed: false,
      createdAt: new Date().toISOString(),
      threadId: "t1",
    };
    const payload = notificationToDeliveryPayload(notification);
    expect(payload.notificationId).toBe("n1");
    expect(payload.deliveryId).toBe("d1");
    expect(payload.title).toBe("Title");
    expect(payload.threadId).toBe("t1");
  });
});

describe("emitCompletionNotification", () => {
  it("emits a chat_reply completion notification", async () => {
    const result = await emitCompletionNotification({
      threadId: "thread-1",
      title: "Done",
      message: "Chat completed",
    });
    expect(result).toBe("in_app_toast");
  });
});

describe("tauri desktop core invoke bridge", () => {
  it("calls __TAURI__.core.invoke when present", async () => {
    const coreInvoke = vi.fn().mockResolvedValue(undefined);
    (window as any).__TAURI__ = { core: { invoke: coreInvoke } };
    const result = await showDesktopNotification(basePayload);
    expect(result).toBe(true);
    expect(coreInvoke).toHaveBeenCalledWith("desktop_show_notification", basePayload);
  });
});

describe("attention tracking and cross-tab suppression", () => {
  it("tracks and detects attended conversation keys", () => {
    const stop = browserNotificationDelivery.trackAttention(() => "thread:test-123");
    expect(browserNotificationDelivery.isConversationAttended("thread:test-123")).toBe(true);
    expect(browserNotificationDelivery.isConversationAttended("thread:other")).toBe(false);
    stop();
  });
});

describe("audio chime", () => {
  it("executes Web Audio chime without throwing", () => {
    expect(() => {
      playNotificationChime();
    }).not.toThrow();
  });
});
