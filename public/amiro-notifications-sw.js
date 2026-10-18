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
  const targetUrl =
    data.url ||
    (data.threadId
      ? `/?thread=${encodeURIComponent(data.threadId)}`
      : data.scheduleId
        ? `/schedules`
        : "/");

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({
              type: "amiro:notification-click",
              threadId: data.threadId || null,
              scheduleId: data.scheduleId || null,
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
