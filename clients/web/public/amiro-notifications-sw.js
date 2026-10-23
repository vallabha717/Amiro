// Amiro Web Notification Service Worker
// Enables reliable OS notifications and click-to-focus routing when Amiro is
// served from a VM or local server in a browser.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // Phase 02: clicks route via the intent's deepLinkTarget, falling back to
  // the legacy flat thread/schedule ids.
  const link = data.deepLinkTarget || {};
  const threadId = link.threadId || data.threadId || null;
  const scheduleId = link.scheduleId || data.scheduleId || null;
  const targetUrl =
    data.url ||
    (threadId
      ? `/?thread=${encodeURIComponent(threadId)}`
      : scheduleId
        ? `/schedules?id=${encodeURIComponent(scheduleId)}`
        : "/");

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({
              type: "amiro:notification-click",
              threadId,
              scheduleId,
              deepLinkTarget: { threadId, scheduleId },
              notificationId: data.notificationId || null,
              actionId: event.action || "view",
              targetUrl,
            });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }),
  );
});
