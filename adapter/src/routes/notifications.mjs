// adapter/src/routes/notifications.mjs -- Vellum-style notification backend
// (Node mirror of backend/src/routes/notifications.rs).
//
// Two owner-scoped JSON stores under $AMIRO_HOME/store:
//   notifications.json          -> { version: 2, items: { <userId>: [ ... ] } }
//   notification-settings.json  -> { <userId>: { ...settings } }
//
// Every create/upsert publishes on a module-level subscriber set so every
// connected SSE client receives `notification_intent` / `notifications_updated`
// immediately. GET /api/notifications/stream seeds a `snapshot` and then relays
// the live events, with a 15s keepalive.
//
// The `silent` flag follows Vellum's completion policy (see resolveSilent).

import crypto from "node:crypto";

const NOTIFICATIONS_KEY = "notifications.json";
const SETTINGS_KEY = "notification-settings.json";

const CATEGORIES = [
  "chat_reply",
  "schedule_result",
  "heartbeat",
  "approval",
  "system",
];
const URGENCIES = ["low", "normal", "high", "critical"];
const STATUSES = ["new", "seen", "acted_on", "dismissed"];
const RECEIPT_CLASSES = [
  "client_os_posted",
  "web_notification",
  "desktop_native",
  "in_app_toast",
];

const KEEPALIVE_MS = 15000;

// Process-wide SSE subscribers. Filled by GET /api/notifications/stream and
// drained on socket close. Single Node process, so a plain Set is enough.
const subscribers = new Set();

export function publish(event) {
  for (const listener of [...subscribers]) {
    try {
      listener(event);
    } catch {
      /* a dead socket must not break fan-out for the others */
    }
  }
}

export function defaultSettings() {
  return {
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
  };
}

function categoryEnabled(settings, category) {
  if (category === "chat_reply") return settings.chatReplyAlerts !== false;
  if (category === "schedule_result") return settings.scheduleAlerts !== false;
  if (category === "heartbeat") return settings.heartbeatAlerts !== false;
  return true;
}

// Vellum completion policy. Returns true when the client must stay quiet.
export function resolveSilent(settings, category, urgency) {
  const s = { ...defaultSettings(), ...(settings || {}) };
  if (s.enabled === false) return true;
  if (!categoryEnabled(s, category)) return true;
  if (s.allAlertsEnabled === true) return false;
  const audibleCategory = [
    "chat_reply",
    "schedule_result",
    "heartbeat",
    "approval",
  ].includes(category);
  const audibleUrgency = ["high", "critical"].includes(urgency);
  return !(audibleCategory || audibleUrgency);
}

function mergeSettings(stored, uid) {
  const base = defaultSettings();
  const mine = stored && typeof stored === "object" ? stored[uid] : null;
  if (mine && typeof mine === "object" && !Array.isArray(mine)) {
    for (const [key, value] of Object.entries(mine)) base[key] = value;
  }
  return base;
}

function itemsFor(doc, uid) {
  const items = doc && doc.items && doc.items[uid];
  return Array.isArray(items) ? items : [];
}

function countUnread(items) {
  return items.filter((item) => item.status === "new").length;
}

function indexOf(items, id) {
  return items.findIndex((item) => item.id === id);
}

function defaultActions(category, threadId) {
  if (category === "chat_reply" || threadId) {
    return [{ id: "view", label: "View Conversation" }];
  }
  return [];
}

export function buildItem(uid, body, settings) {
  const input = body && typeof body === "object" ? body : {};
  const category =
    typeof input.category === "string" ? input.category : "system";
  if (!CATEGORIES.includes(category)) {
    const err = new Error(`unknown notification category: ${category}`);
    err.status = 400;
    throw err;
  }
  const urgency = typeof input.urgency === "string" ? input.urgency : "normal";
  if (!URGENCIES.includes(urgency)) {
    const err = new Error(`unknown notification urgency: ${urgency}`);
    err.status = 400;
    throw err;
  }
  const status = typeof input.status === "string" ? input.status : "new";
  if (!STATUSES.includes(status)) {
    const err = new Error(`unknown notification status: ${status}`);
    err.status = 400;
    throw err;
  }

  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id
      : crypto.randomUUID();
  const threadId = typeof input.threadId === "string" ? input.threadId : null;
  const scheduleId =
    typeof input.scheduleId === "string" ? input.scheduleId : null;
  const text =
    typeof input.body === "string"
      ? input.body
      : typeof input.summary === "string"
        ? input.summary
        : "";
  const now = new Date().toISOString();
  const silent =
    typeof input.silent === "boolean"
      ? input.silent
      : resolveSilent(settings, category, urgency);

  return {
    id,
    userId: uid,
    title: typeof input.title === "string" ? input.title : "",
    body: text,
    summary: text,
    category,
    urgency,
    status,
    silent,
    threadId,
    scheduleId,
    sourceEventName:
      typeof input.sourceEventName === "string"
        ? input.sourceEventName
        : "system.notification",
    actions: Array.isArray(input.actions)
      ? input.actions
      : defaultActions(category, threadId),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: now,
    ackedAt: null,
    deliveryReceipt: null,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(app, ctx) {
  // Wrap a handler so thrown validation/not-found errors become JSON HTTP
  // responses (mirroring the Rust handlers' ApiError), instead of rejecting the
  // request pipeline.
  const guard = (handler) => async (req, res, params) => {
    try {
      await handler(req, res, params);
    } catch (err) {
      const status = (err && err.status) || 500;
      ctx.error(res, status, err && err.message ? err.message : String(err));
    }
  };

  async function loadNotifications() {
    const doc = await ctx.store.read(NOTIFICATIONS_KEY, {
      version: 2,
      items: {},
    });
    if (
      !doc ||
      typeof doc !== "object" ||
      !doc.items ||
      typeof doc.items !== "object"
    ) {
      return { version: 2, items: {} };
    }
    return doc;
  }

  async function saveNotifications(doc) {
    await ctx.store.write(NOTIFICATIONS_KEY, doc);
  }

  async function loadSettingsDoc() {
    const doc = await ctx.store.read(SETTINGS_KEY, {});
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  }

  async function settingsFor(uid) {
    return mergeSettings(await loadSettingsDoc(), uid);
  }

  // Persist one item: replace in place when the id already exists, otherwise
  // prepend so the feed stays newest-first. Returns the unread count.
  async function persistItem(uid, item) {
    const doc = await loadNotifications();
    const items = [...itemsFor(doc, uid)];
    const at = indexOf(items, item.id);
    if (at >= 0) items[at] = item;
    else items.unshift(item);
    doc.items = { ...doc.items, [uid]: items };
    doc.version = 2;
    await saveNotifications(doc);
    return countUnread(items);
  }

  function broadcastIntent(uid, item, unreadCount) {
    publish({
      type: "notification_intent",
      userId: uid,
      notification: item,
      unreadCount,
    });
  }

  // Public helper other routes (schedules/heartbeat/chat) can call.
  async function emitNotification(
    uid,
    title,
    body,
    category,
    urgency,
    threadId = null,
    scheduleId = null,
    sourceEventName = "system.notification",
  ) {
    const settings = await settingsFor(uid);
    const item = buildItem(
      uid,
      { title, body, category, urgency, threadId, scheduleId, sourceEventName },
      settings,
    );
    const unreadCount = await persistItem(uid, item);
    broadcastIntent(uid, item, unreadCount);
    return item;
  }

  async function mutateItem(uid, id, mutate) {
    const doc = await loadNotifications();
    const items = [...itemsFor(doc, uid)];
    const at = indexOf(items, id);
    if (at < 0) {
      const err = new Error("notification not found");
      err.status = 404;
      throw err;
    }
    const next = { ...items[at] };
    mutate(next);
    next.updatedAt = ctx.nowIso();
    items[at] = next;
    doc.items = { ...doc.items, [uid]: items };
    doc.version = 2;
    await saveNotifications(doc);
    return { item: next, unreadCount: countUnread(items) };
  }

  // GET /api/notifications -- feed + settings + unread count.
  app.get(
    "/api/notifications",
    guard(async (req, res) => {
      const user = ctx.requireUser(req);
      const doc = await loadNotifications();
      const settings = await settingsFor(user.id);
      const url = new URL(req.url || "/", "http://localhost");
      const includeDismissed =
        url.searchParams.get("includeDismissed") === "true";
      const unreadOnly = url.searchParams.get("unreadOnly") === "true";

      let items = itemsFor(doc, user.id).filter((item) => {
        if (!includeDismissed && item.status === "dismissed") return false;
        if (unreadOnly && item.status !== "new") return false;
        return true;
      });
      const unreadCount = countUnread(items);
      items = [...items].sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
      );
      const updatedAt =
        items.reduce(
          (acc, item) =>
            String(item.updatedAt || "") > acc ? String(item.updatedAt) : acc,
          "",
        ) || ctx.nowIso();

      ctx.json(res, 200, {
        version: 2,
        items,
        unreadCount,
        updatedAt,
        settings,
      });
    }),
  );

  // POST /api/notifications -- create or upsert.
  app.post(
    "/api/notifications",
    guard(async (req, res) => {
      const user = ctx.requireUser(req);
      const body = await ctx.readJson(req);
      const settings = await settingsFor(user.id);
      const item = buildItem(user.id, body, settings);
      const unreadCount = await persistItem(user.id, item);
      broadcastIntent(user.id, item, unreadCount);
      ctx.json(res, 201, { item, unreadCount });
    }),
  );

  // POST /api/notifications/test -- real end-to-end test notification.
  app.post(
    "/api/notifications/test",
    guard(async (req, res) => {
      const user = ctx.requireUser(req);
      const settings = await settingsFor(user.id);
      const item = buildItem(
        user.id,
        {
          title: "Amiro Test Notification",
          body: "Notifications are working across Web UI and Desktop.",
          category: "system",
          urgency: "high",
          sourceEventName: "system.test",
          actions: [{ id: "dismiss", label: "Dismiss" }],
        },
        settings,
      );
      const unreadCount = await persistItem(user.id, item);
      broadcastIntent(user.id, item, unreadCount);
      ctx.json(res, 201, { item, unreadCount });
    }),
  );

  // POST /api/notifications/mark-all-read
  app.post(
    "/api/notifications/mark-all-read",
    guard(async (req, res) => {
      const user = ctx.requireUser(req);
      const doc = await loadNotifications();
      const items = [...itemsFor(doc, user.id)];
      let updated = 0;
      for (const item of items) {
        if (item.status === "new") {
          item.status = "seen";
          item.seenAt = ctx.nowIso();
          item.updatedAt = ctx.nowIso();
          updated += 1;
        }
      }
      doc.items = { ...doc.items, [user.id]: items };
      doc.version = 2;
      await saveNotifications(doc);
      const unreadCount = countUnread(items);
      publish({ type: "notifications_updated", userId: user.id, unreadCount });
      ctx.json(res, 200, { updated, unreadCount });
    }),
  );

  // POST /api/notifications/clear-all
  app.post(
    "/api/notifications/clear-all",
    guard(async (req, res) => {
      const user = ctx.requireUser(req);
      const doc = await loadNotifications();
      const items = [...itemsFor(doc, user.id)];
      let cleared = 0;
      for (const item of items) {
        if (item.status !== "dismissed") {
          item.status = "dismissed";
          item.updatedAt = ctx.nowIso();
          cleared += 1;
        }
      }
      doc.items = { ...doc.items, [user.id]: items };
      doc.version = 2;
      await saveNotifications(doc);
      const unreadCount = countUnread(items);
      publish({ type: "notifications_updated", userId: user.id, unreadCount });
      ctx.json(res, 200, { cleared, unreadCount });
    }),
  );

  // GET /api/notifications/settings
  app.get(
    "/api/notifications/settings",
    guard(async (req, res) => {
      const user = ctx.requireUser(req);
      ctx.json(res, 200, await settingsFor(user.id));
    }),
  );

  // PUT /api/notifications/settings -- partial merge.
  app.put(
    "/api/notifications/settings",
    guard(async (req, res) => {
      const user = ctx.requireUser(req);
      const body = await ctx.readJson(req);
      const doc = await loadSettingsDoc();
      const merged = { ...mergeSettings(doc, user.id) };
      if (body && typeof body === "object" && !Array.isArray(body)) {
        for (const [key, value] of Object.entries(body)) merged[key] = value;
      }
      doc[user.id] = merged;
      await ctx.store.write(SETTINGS_KEY, doc);
      ctx.json(res, 200, merged);
    }),
  );

  // PUT (and PATCH when the router supports it) /api/notifications/:id
  async function patchHandler(req, res, params) {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    if (typeof body.status === "string" && !STATUSES.includes(body.status)) {
      ctx.error(res, 400, `unknown notification status: ${body.status}`);
      return;
    }
    const result = await mutateItem(user.id, params.id, (item) => {
      if (typeof body.status === "string") {
        item.status = body.status;
        if (body.status !== "new" && !item.seenAt) item.seenAt = ctx.nowIso();
      }
      if (typeof body.title === "string") item.title = body.title;
      const text =
        typeof body.body === "string"
          ? body.body
          : typeof body.summary === "string"
            ? body.summary
            : null;
      if (text !== null) {
        item.body = text;
        item.summary = text;
      }
    });
    publish({
      type: "notifications_updated",
      userId: user.id,
      unreadCount: result.unreadCount,
      notification: result.item,
    });
    ctx.json(res, 200, result);
  }
  app.put("/api/notifications/:id", guard(patchHandler));
  if (typeof app.patch === "function")
    app.patch("/api/notifications/:id", guard(patchHandler));

  // POST /api/notifications/:id/ack -- Vellum-style client delivery receipt.
  app.post(
    "/api/notifications/:id/ack",
    guard(async (req, res, params) => {
      const user = ctx.requireUser(req);
      const body = await ctx.readJson(req);
      const delivered =
        body.delivered === undefined ? true : body.delivered === true;
      const receiptClass =
        typeof body.receiptClass === "string"
          ? body.receiptClass
          : "client_os_posted";
      if (!RECEIPT_CLASSES.includes(receiptClass)) {
        ctx.error(res, 400, `unknown receiptClass: ${receiptClass}`);
        return;
      }
      const result = await mutateItem(user.id, params.id, (item) => {
        item.ackedAt = delivered ? ctx.nowIso() : null;
        item.deliveryReceipt = delivered ? receiptClass : null;
      });
      ctx.json(res, 200, {
        delivered,
        receiptClass,
        item: result.item,
        unreadCount: result.unreadCount,
      });
    }),
  );

  // GET /api/notifications/stream -- SSE snapshot + live fan-out.
  app.get("/api/notifications/stream", async (req, res) => {
    const user = ctx.requireUser(req);
    const doc = await loadNotifications();
    const unreadCount = countUnread(itemsFor(doc, user.id));

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        /* client gone */
      }
    };
    send({ type: "snapshot", unreadCount });

    const listener = (event) => {
      const owner =
        (event && typeof event.userId === "string" && event.userId) ||
        (event &&
          event.notification &&
          typeof event.notification.userId === "string" &&
          event.notification.userId) ||
        null;
      if (owner && owner !== user.id) return;
      send(event);
    };
    subscribers.add(listener);
    const keepalive = setInterval(() => {
      try {
        res.write("data: keepalive\n\n");
      } catch {
        /* ignore */
      }
    }, KEEPALIVE_MS);
    if (typeof keepalive.unref === "function") keepalive.unref();

    const cleanup = () => {
      clearInterval(keepalive);
      subscribers.delete(listener);
    };
    if (typeof res.on === "function") {
      res.on("close", cleanup);
      res.on("finish", cleanup);
    }
  });

  return { emitNotification, publish };
}

// Test surface: pure helpers reachable without registering routes.
export const _internals = {
  categoryEnabled,
  countUnread,
  mergeSettings,
  CATEGORIES,
  URGENCIES,
  STATUSES,
  RECEIPT_CLASSES,
};
