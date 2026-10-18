// Tests for adapter/src/routes/notifications.mjs -- the Node mirror of the
// Rust notification backend. Drives the real registered handlers through a
// minimal fake router/ctx, plus a fake SSE response for the stream.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildItem,
  defaultSettings,
  publish,
  register,
  resolveSilent,
} from "../src/routes/notifications.mjs";
import { createStore } from "../src/store.mjs";

const USER = { id: "user-1", role: "user" };

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    raw: undefined,
    writes: [],
    handlers: {},
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
      this.headersSent = true;
    },
    write(chunk) {
      this.writes.push(chunk);
    },
    flushHeaders() {},
    on(event, cb) {
      this.handlers[event] = cb;
    },
    end(body) {
      this.raw = body;
    },
  };
}

function compilePattern(pattern) {
  const keys = [];
  const body = pattern
    .replace(/\/+$/, "")
    .replace(/\/:([A-Za-z0-9_]+)/g, (_m, k) => {
      keys.push(k);
      return "/([^/]+)";
    });
  return { regex: new RegExp(`^${body || "/"}/?$`), keys };
}

async function makeHarness() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "amiro-notify-adapter-"),
  );
  const store = createStore(root);
  const routes = new Map();
  const app = {
    get(p, h) {
      routes.set(`GET ${p}`, h);
    },
    put(p, h) {
      routes.set(`PUT ${p}`, h);
    },
    post(p, h) {
      routes.set(`POST ${p}`, h);
    },
  };
  const ctx = {
    config: { home: root },
    store,
    log: () => {},
    nowIso: () => new Date().toISOString(),
    readJson: async (req) => req._body || {},
    requireUser(req) {
      if (req.user) return req.user;
      const err = new Error("Unauthorized");
      err.status = 401;
      throw err;
    },
    json(res, status, obj) {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(obj));
    },
    error(res, status, message) {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ error: String(message) }));
    },
  };
  register(app, ctx);

  async function call(
    method,
    route,
    body = undefined,
    user = USER,
    url = undefined,
  ) {
    for (const [regKey, handler] of routes) {
      const [regMethod, pattern] = regKey.split(" ");
      if (regMethod !== method) continue;
      const { regex, keys } = compilePattern(pattern);
      const match = regex.exec(route);
      if (!match) continue;
      const params = {};
      keys.forEach((k, i) => {
        params[k] = decodeURIComponent(match[i + 1]);
      });
      const res = makeRes();
      await handler(
        { user: user || undefined, _body: body, url: url || route },
        res,
        params,
      );
      let parsed;
      if (res.raw !== undefined && typeof res.raw === "string") {
        try {
          parsed = JSON.parse(res.raw);
        } catch {
          parsed = undefined;
        }
      }
      return { status: res.statusCode, res, json: parsed };
    }
    assert.fail(`route ${method} ${route} not registered`);
    return undefined;
  }

  return {
    root,
    store,
    ctx,
    routes,
    call,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Pure policy helpers
// ---------------------------------------------------------------------------

test("resolveSilent follows the Vellum completion policy", () => {
  const on = defaultSettings();
  assert.equal(resolveSilent(on, "chat_reply", "normal"), false);
  assert.equal(resolveSilent(on, "system", "low"), false);

  const alertsOff = { ...on, allAlertsEnabled: false };
  assert.equal(resolveSilent(alertsOff, "chat_reply", "low"), false);
  assert.equal(resolveSilent(alertsOff, "approval", "normal"), false);
  assert.equal(resolveSilent(alertsOff, "system", "critical"), false);
  assert.equal(resolveSilent(alertsOff, "system", "low"), true);

  assert.equal(
    resolveSilent({ ...on, enabled: false }, "chat_reply", "critical"),
    true,
  );
  assert.equal(
    resolveSilent({ ...on, chatReplyAlerts: false }, "chat_reply", "high"),
    true,
  );
  assert.equal(
    resolveSilent({ ...on, chatReplyAlerts: false }, "heartbeat", "high"),
    false,
  );
});

test("buildItem validates enums and fills defaults", () => {
  const settings = defaultSettings();
  assert.throws(
    () => buildItem("u1", { title: "x", category: "nope" }, settings),
    /category/,
  );
  assert.throws(
    () => buildItem("u1", { title: "x", urgency: "extreme" }, settings),
    /urgency/,
  );

  const item = buildItem("u1", { title: "x" }, settings);
  assert.equal(item.category, "system");
  assert.equal(item.urgency, "normal");
  assert.equal(item.status, "new");
  assert.equal(item.userId, "u1");
  assert.ok(item.id);
  assert.equal(item.ackedAt, null);

  const chat = buildItem(
    "u1",
    { title: "x", category: "chat_reply", threadId: "t1" },
    settings,
  );
  assert.deepEqual(chat.actions, [{ id: "view", label: "View Conversation" }]);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test("notifications require an authenticated user", async () => {
  const h = await makeHarness();
  try {
    const get = await h.call("GET", "/api/notifications", undefined, null);
    assert.equal(get.status, 401);
    assert.match(get.json.error, /Unauthorized/);
    const post = await h.call(
      "POST",
      "/api/notifications",
      { title: "x" },
      null,
    );
    assert.equal(post.status, 401);
  } finally {
    await h.cleanup();
  }
});

test("empty feed returns version 2 and default settings", async () => {
  const h = await makeHarness();
  try {
    const { status, json } = await h.call("GET", "/api/notifications");
    assert.equal(status, 200);
    assert.equal(json.version, 2);
    assert.deepEqual(json.items, []);
    assert.equal(json.unreadCount, 0);
    assert.equal(typeof json.updatedAt, "string");
    assert.equal(json.settings.enabled, true);
    assert.equal(json.settings.quietEnd, "08:00");

    const settings = await h.call("GET", "/api/notifications/settings");
    assert.equal(settings.json.webPushEnabled, true);
  } finally {
    await h.cleanup();
  }
});

test("create persists, lists newest-first, and upserts in place", async () => {
  const h = await makeHarness();
  try {
    const created = await h.call("POST", "/api/notifications", {
      id: "fixed-id",
      title: "Reply ready",
      body: "Answered.",
      category: "chat_reply",
      urgency: "high",
      threadId: "thread-1",
      sourceEventName: "chat.assistant_reply",
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.unreadCount, 1);
    const item = created.json.item;
    assert.equal(item.id, "fixed-id");
    assert.equal(item.userId, "user-1");
    assert.equal(item.status, "new");
    assert.equal(item.silent, false);
    assert.equal(item.actions[0].id, "view");

    await h.call("POST", "/api/notifications", {
      id: "second",
      title: "Second",
    });
    await h.call("POST", "/api/notifications", {
      id: "fixed-id",
      title: "Reply edited",
      category: "chat_reply",
    });

    const feed = await h.call("GET", "/api/notifications");
    assert.equal(feed.json.items.length, 2);
    const ids = feed.json.items.map((i) => i.id).sort();
    assert.deepEqual(ids, ["fixed-id", "second"]);
    assert.equal(
      feed.json.items.find((i) => i.id === "fixed-id").title,
      "Reply edited",
    );
    assert.equal(feed.json.unreadCount, 2);

    const bad = await h.call("POST", "/api/notifications", {
      title: "bad",
      category: "nope",
    });
    assert.equal(bad.status, 400);
  } finally {
    await h.cleanup();
  }
});

test("PUT updates status, mark-all-read and clear-all work with filters", async () => {
  const h = await makeHarness();
  try {
    await h.call("POST", "/api/notifications", { id: "a", title: "a" });
    await h.call("POST", "/api/notifications", { id: "b", title: "b" });

    const patched = await h.call("PUT", "/api/notifications/a", {
      status: "seen",
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.item.status, "seen");
    assert.equal(patched.json.unreadCount, 1);

    const edited = await h.call("PUT", "/api/notifications/b", {
      title: "Edited",
      body: "New body",
    });
    assert.equal(edited.json.item.title, "Edited");
    assert.equal(edited.json.item.body, "New body");

    const missing = await h.call("PUT", "/api/notifications/zzz", {
      status: "seen",
    });
    assert.equal(missing.status, 404);
    const badStatus = await h.call("PUT", "/api/notifications/a", {
      status: "bogus",
    });
    assert.equal(badStatus.status, 400);

    const marked = await h.call("POST", "/api/notifications/mark-all-read");
    assert.equal(marked.json.unreadCount, 0);

    const unread = await h.call(
      "GET",
      "/api/notifications",
      undefined,
      USER,
      "/api/notifications?unreadOnly=true",
    );
    assert.deepEqual(unread.json.items, []);

    const cleared = await h.call("POST", "/api/notifications/clear-all");
    assert.equal(cleared.json.cleared, 2);
    assert.equal(cleared.json.unreadCount, 0);

    const visible = await h.call("GET", "/api/notifications");
    assert.deepEqual(visible.json.items, []);
    const all = await h.call(
      "GET",
      "/api/notifications",
      undefined,
      USER,
      "/api/notifications?includeDismissed=true",
    );
    assert.equal(all.json.items.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("ack records a client delivery receipt", async () => {
  const h = await makeHarness();
  try {
    await h.call("POST", "/api/notifications", { id: "n1", title: "Hello" });
    const acked = await h.call("POST", "/api/notifications/n1/ack", {
      delivered: true,
      receiptClass: "web_notification",
    });
    assert.equal(acked.status, 200);
    assert.equal(acked.json.delivered, true);
    assert.equal(acked.json.receiptClass, "web_notification");
    assert.equal(acked.json.item.deliveryReceipt, "web_notification");
    assert.equal(typeof acked.json.item.ackedAt, "string");

    const inApp = await h.call("POST", "/api/notifications/n1/ack", {
      delivered: true,
      receiptClass: "in_app_toast",
    });
    assert.equal(inApp.status, 200);
    assert.equal(inApp.json.item.deliveryReceipt, "in_app_toast");

    const bad = await h.call("POST", "/api/notifications/n1/ack", {
      delivered: true,
      receiptClass: "pigeon",
    });
    assert.equal(bad.status, 400);
  } finally {
    await h.cleanup();
  }
});

test("settings gate silencing of new notifications", async () => {
  const h = await makeHarness();
  try {
    const updated = await h.call("PUT", "/api/notifications/settings", {
      enabled: false,
    });
    assert.equal(updated.json.enabled, false);
    assert.equal(updated.json.quietStart, "22:00");

    const quiet = await h.call("POST", "/api/notifications", {
      title: "Quiet",
      category: "chat_reply",
      urgency: "critical",
    });
    assert.equal(quiet.json.item.silent, true);

    await h.call("PUT", "/api/notifications/settings", {
      enabled: true,
      allAlertsEnabled: false,
    });
    const lowSystem = await h.call("POST", "/api/notifications", {
      title: "S",
      category: "system",
      urgency: "low",
    });
    assert.equal(lowSystem.json.item.silent, true);
  } finally {
    await h.cleanup();
  }
});

test("test endpoint emits a real notification", async () => {
  const h = await makeHarness();
  try {
    const { status, json } = await h.call("POST", "/api/notifications/test");
    assert.equal(status, 201);
    assert.equal(json.item.title, "Amiro Test Notification");
    assert.equal(
      json.item.body,
      "Notifications are working across Web UI and Desktop.",
    );
    assert.equal(json.item.category, "system");
    assert.equal(json.item.urgency, "high");
    assert.equal(json.item.sourceEventName, "system.test");
  } finally {
    await h.cleanup();
  }
});

test("stream seeds a snapshot and relays live intent events", async () => {
  const h = await makeHarness();
  try {
    await h.call("POST", "/api/notifications", { id: "seed", title: "Seed" });

    const streamHandler = h.routes.get("GET /api/notifications/stream");
    assert.ok(streamHandler, "stream route registered");
    const streamRes = makeRes();
    await streamHandler(
      { user: USER, url: "/api/notifications/stream" },
      streamRes,
    );

    assert.equal(streamRes.statusCode, 200);
    assert.match(streamRes.headers["Content-Type"], /text\/event-stream/);
    assert.match(streamRes.writes[0], /"type":"snapshot"/);
    assert.match(streamRes.writes[0], /"unreadCount":1/);

    await h.call("POST", "/api/notifications", { id: "live", title: "Live" });
    const relayed = streamRes.writes.find(
      (chunk) =>
        chunk.includes("notification_intent") && chunk.includes("live"),
    );
    assert.ok(relayed, "live notification_intent was relayed over SSE");

    // Cleanup so the listener does not leak into later publishes.
    if (typeof streamRes.handlers.close === "function")
      streamRes.handlers.close();
  } finally {
    await h.cleanup();
  }
});

test("publish fans out to matching subscribers only", async () => {
  const h = await makeHarness();
  try {
    const streamHandler = h.routes.get("GET /api/notifications/stream");
    const streamRes = makeRes();
    await streamHandler(
      { user: USER, url: "/api/notifications/stream" },
      streamRes,
    );

    publish({
      type: "notification_intent",
      userId: "user-1",
      notification: { id: "mine", userId: "user-1" },
      unreadCount: 1,
    });
    publish({
      type: "notification_intent",
      userId: "someone-else",
      notification: { id: "theirs", userId: "someone-else" },
      unreadCount: 1,
    });

    const pushed = streamRes.writes.slice(1);
    assert.equal(pushed.length, 1, "only the matching-user event is relayed");
    assert.match(pushed[0], /"mine"/);
    assert.doesNotMatch(pushed[0], /"theirs"/);

    if (typeof streamRes.handlers.close === "function")
      streamRes.handlers.close();
  } finally {
    await h.cleanup();
  }
});
