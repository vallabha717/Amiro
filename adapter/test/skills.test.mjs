// adapter/test/skills.test.mjs -- safety and truthfulness tests for the skill
// routes (adapter/src/routes/skills.mjs).
//
// Focus is deliberately narrow: the things that would be a security or honesty
// bug if they regressed.
//   1. A skill name can never reach the filesystem unless it passes the strict
//      name rule, so `../../x` cannot escape the workspace mirror.
//   2. The workspace mirror stays inside <workspaceDir>/skills.
//   3. Skill CRUD is per user: one user can never see or mutate another's.
//   4. Ownerless legacy skills.json records are not exposed to anyone.
//   5. A SKILL.md that resolves outside its skills root is refused.
//   6. An out-of-roots `project` is refused, not silently swapped.
//   7. reportable capability (deliverable/invokable) tells the truth about
//      whether this process exposes tools, and stays in step with chat.mjs.

import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../src/store.mjs";
import {
  isValidSkillName,
  resolveSkillForTurn,
  skillGenerationEnabled,
  toolsExposed,
  register,
} from "../src/routes/skills.mjs";
import { toolsEnabled } from "../src/chat.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) =>
    routes.set(`${method} ${route}`, handler);
  return {
    routes,
    get: add("GET"),
    post: add("POST"),
    put: add("PUT"),
    delete: add("DELETE"),
  };
}

function makeSse() {
  const frames = [];
  const sse = {
    frames,
    start: (id) => frames.push(["start", id]),
    startStep: () => frames.push(["start-step"]),
    finishStep: () => frames.push(["finish-step"]),
    textStart: (id) => frames.push(["text-start", id]),
    textDelta: (id, delta) => frames.push(["text-delta", id, delta]),
    textEnd: (id) => frames.push(["text-end", id]),
    finish: (meta) => frames.push(["finish", meta]),
    done: () => frames.push(["done"]),
    error: (message) => frames.push(["error", message]),
    open: true,
  };
  return sse;
}

async function makeHarness({ userId = "user-a" } = {}) {
  const home = await fs.mkdtemp(path.join("/tmp", "amiro-skills-home-"));
  const workspaceDir = path.join(home, "workspace");
  const projectDir = await fs.mkdtemp(
    path.join("/tmp", "amiro-skills-project-"),
  );
  // A separate runtime home so discovery cannot touch the real engine state
  // directory (the engine's own legacy `~/.jcode`, used on disk only).
  const runtimeHome = path.join(home, ".jcode");
  await fs.mkdir(workspaceDir, { recursive: true });

  const store = createStore(home);
  const app = makeApp();
  const logs = [];
  let pendingBody = "{}";

  const ctx = {
    config: { home, workspaceDir, runtimeHome, outDir: here },
    store,
    nowIso: () => new Date().toISOString(),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    json: (res, status, body) => {
      res.status = status;
      res.body = body;
    },
    error: (res, status, message) => {
      res.status = status;
      res.body = { error: message };
    },
    sse: () => makeSse(),
    readJson: async () => JSON.parse(pendingBody || "{}"),
    requireUser: () => ({ id: userId, name: userId }),
  };

  register(app, ctx);

  return {
    home,
    workspaceDir,
    projectDir,
    runtimeHome,
    store,
    logs,
    ctx,
    routes: app.routes,
    setUser(nextId) {
      ctx.requireUser = () => ({ id: nextId, name: nextId });
    },
    async call(method, route, { params = {}, url = route, body } = {}) {
      const handler = app.routes.get(`${method} ${route}`);
      assert.ok(handler, `route ${method} ${route} is registered`);
      pendingBody = body === undefined ? "{}" : body;
      const res = {};
      await handler({ url, method }, res, params);
      return res;
    },
    async cleanup() {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    },
  };
}

test("strict skill names reject traversal, separators and oversized names", () => {
  for (const good of ["a", "better-colors", "skill-2", "x".repeat(64)]) {
    assert.equal(isValidSkillName(good), true, `${good} should be valid`);
  }
  for (const bad of [
    "",
    "../etc",
    "..",
    "a/b",
    "a\\b",
    "a..b",
    "Bad_Name",
    "has space",
    "UPPER",
    "-leading",
    "trailing-",
    "double--hyphen",
    "x".repeat(65),
    "%2e%2e%2fetc",
  ]) {
    assert.equal(isValidSkillName(bad), false, `${bad} should be rejected`);
  }
});

test("create rejects a traversal name and writes nothing outside the mirror", async () => {
  const h = await makeHarness();
  try {
    const res = await h.call("POST", "/api/skills", {
      body: JSON.stringify({
        name: "../../escaped",
        description: "x",
        body: "y",
      }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /lowercase letters/);
    // The escape target must not exist anywhere above the mirror root.
    await assert.rejects(fs.stat(path.join(h.workspaceDir, "..", "escaped")));
    await assert.rejects(fs.stat(path.join(h.home, "escaped")));
    await assert.rejects(fs.stat(path.join(h.workspaceDir, "skills")));
  } finally {
    await h.cleanup();
  }
});

test("create writes the store file per user and mirrors SKILL.md inside the workspace", async () => {
  const h = await makeHarness({ userId: "user-a" });
  try {
    const res = await h.call("POST", "/api/skills", {
      body: JSON.stringify({
        name: "night-shift",
        description: "Runs the night shift",
        body: "# Night shift",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.skill.name, "night-shift");
    assert.deepEqual(res.body.warnings, []);

    const storeFile = path.join(h.home, "store", "skills", "user-a.json");
    const stored = JSON.parse(await fs.readFile(storeFile, "utf8"));
    assert.ok(stored["night-shift"], "skill stored under the per-user file");

    const mirror = await fs.readFile(
      path.join(h.workspaceDir, "skills", "night-shift", "SKILL.md"),
      "utf8",
    );
    assert.match(mirror, /name: night-shift/);
    assert.match(mirror, /# Night shift/);

    // A global skills.json must not be created by this adapter any more.
    await assert.rejects(fs.stat(path.join(h.home, "store", "skills.json")));
  } finally {
    await h.cleanup();
  }
});

test("skill CRUD is per user: a second user cannot see, edit or delete the first user store", async () => {
  const h = await makeHarness({ userId: "user-a" });
  try {
    await h.call("POST", "/api/skills", {
      body: JSON.stringify({
        name: "private-skill",
        description: "mine",
        body: "# mine",
      }),
    });

    h.setUser("user-b");
    const list = await h.call("GET", "/api/skills");
    assert.equal(list.status, 200);
    assert.equal(
      list.body.items.some((s) => s.name === "private-skill"),
      false,
      "user B must not see user A skill",
    );

    const detail = await h.call("GET", "/api/skills/items/:name", {
      params: { name: "private-skill" },
      url: "/api/skills/items/private-skill",
    });
    assert.equal(detail.status, 404, "user B must not read user A skill");

    const update = await h.call("PUT", "/api/skills/items/:name", {
      params: { name: "private-skill" },
      body: JSON.stringify({ body: "hijacked" }),
    });
    assert.equal(update.status, 404, "user B must not edit user A skill");

    const remove = await h.call("DELETE", "/api/skills/items/:name", {
      params: { name: "private-skill" },
    });
    assert.equal(remove.status, 404, "user B must not delete user A skill");

    const stored = JSON.parse(
      await fs.readFile(
        path.join(h.home, "store", "skills", "user-a.json"),
        "utf8",
      ),
    );
    assert.equal(
      stored["private-skill"].body,
      "# mine",
      "user A skill untouched",
    );
  } finally {
    await h.cleanup();
  }
});

test("ownerless legacy skills.json is reported and never exposed", async () => {
  const h = await makeHarness({ userId: "user-a" });
  try {
    await fs.mkdir(path.join(h.home, "store"), { recursive: true });
    await fs.writeFile(
      path.join(h.home, "store", "skills.json"),
      JSON.stringify({
        "legacy-skill": { name: "legacy-skill", body: "# legacy" },
      }),
    );

    const list = await h.call("GET", "/api/skills");
    assert.equal(list.status, 200);
    assert.equal(
      list.body.items.some((s) => s.name === "legacy-skill"),
      false,
      "ownerless records must not be listed",
    );
    assert.ok(
      list.body.diagnostics.some((d) => /no owner/.test(d.message)),
      "the legacy file must be surfaced as a diagnostic",
    );
  } finally {
    await h.cleanup();
  }
});

test("a SKILL.md that resolves outside its skills root is refused with an error diagnostic", async () => {
  const h = await makeHarness();
  try {
    const outside = path.join(h.home, "outside.md");
    await fs.writeFile(outside, "# Leaked\n\nShould never be read.");
    const root = path.join(h.projectDir, ".agents", "skills");
    await fs.mkdir(path.join(root, "sneaky"), { recursive: true });
    await fs.symlink(outside, path.join(root, "sneaky", "SKILL.md"));

    const list = await h.call("GET", "/api/skills", {
      url: `/api/skills?project=${encodeURIComponent(h.projectDir)}`,
    });
    assert.equal(list.status, 200);
    assert.equal(
      list.body.items.some((s) => s.name === "sneaky"),
      false,
      "a symlinked-out SKILL.md must not be listed",
    );
    assert.ok(
      list.body.diagnostics.some(
        (d) =>
          d.severity === "error" && /outside its skills root/.test(d.message),
      ),
      "the refusal must be reported",
    );
  } finally {
    await h.cleanup();
  }
});

test("a project outside the browse roots is refused instead of silently swapped", async () => {
  const h = await makeHarness();
  const previous = process.env.AMIRO_BROWSE_ROOTS;
  process.env.AMIRO_BROWSE_ROOTS = h.projectDir;
  try {
    const res = await h.call("GET", "/api/skills", {
      url: `/api/skills?project=${encodeURIComponent("/etc")}`,
    });
    assert.ok(
      res.status === 403 || res.status === 400,
      `expected refusal, got ${res.status}`,
    );
    assert.equal(
      res.body.items,
      undefined,
      "no directory listing is returned on refusal",
    );
  } finally {
    if (previous === undefined) delete process.env.AMIRO_BROWSE_ROOTS;
    else process.env.AMIRO_BROWSE_ROOTS = previous;
    await h.cleanup();
  }
});

test("resolveSkillForTurn resolves only this user catalog, and never a client path", async () => {
  const h = await makeHarness({ userId: "user-a" });
  const previous = process.env.AMIRO_BROWSE_ROOTS;
  process.env.AMIRO_BROWSE_ROOTS = h.projectDir;
  try {
    await h.call("POST", "/api/skills", {
      body: JSON.stringify({
        name: "mine-only",
        description: "d",
        body: "# Mine only",
      }),
    });

    const own = await resolveSkillForTurn(h.ctx, "mine-only", h.projectDir, {
      id: "user-a",
    });
    assert.ok(own, "own skill resolves");
    assert.equal(own.body, "# Mine only");
    assert.equal(
      own.invokable,
      false,
      "tools are off, so it is readable but not executable",
    );

    assert.equal(
      await resolveSkillForTurn(h.ctx, "other-user-skill", h.projectDir, {
        id: "user-a",
      }),
      null,
    );
    assert.equal(
      await resolveSkillForTurn(h.ctx, "mine-only", h.projectDir, {
        id: "user-b",
      }),
      null,
    );
    for (const evil of [
      "../secret",
      "a/b",
      "/etc/passwd",
      "..",
      "",
      "x".repeat(200),
    ]) {
      assert.equal(
        await resolveSkillForTurn(h.ctx, evil, h.projectDir, { id: "user-a" }),
        null,
        `${evil} must not resolve`,
      );
    }

    // A real discovered skill in the project tree is delivered, read-only.
    const dir = path.join(h.projectDir, ".agents", "skills", "discovered");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: discovered\ndescription: From the project\n---\n\n# Steps\n\n1. Do it.\n",
    );
    const found = await resolveSkillForTurn(h.ctx, "discovered", h.projectDir, {
      id: "user-a",
    });
    assert.ok(found, "a discovered project skill resolves");
    assert.equal(found.scope, "project");
    assert.match(found.body, /# Steps/);
    // The same skill must not resolve when the project is not in scope.
    assert.equal(
      await resolveSkillForTurn(h.ctx, "discovered", undefined, {
        id: "user-a",
      }),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.AMIRO_BROWSE_ROOTS;
    else process.env.AMIRO_BROWSE_ROOTS = previous;
    await h.cleanup();
  }
});

test("disable-model-invocation is honoured and reported", async () => {
  const h = await makeHarness();
  const previous = process.env.AMIRO_BROWSE_ROOTS;
  process.env.AMIRO_BROWSE_ROOTS = h.projectDir;
  try {
    const dir = path.join(h.projectDir, ".agents", "skills", "manual-only");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: manual-only\ndescription: Humans only\ndisable-model-invocation: true\n---\n\n# Manual\n",
    );

    const list = await h.call("GET", "/api/skills", {
      url: `/api/skills?project=${encodeURIComponent(h.projectDir)}`,
    });
    const item = list.body.items.find((s) => s.name === "manual-only");
    assert.ok(item, "the skill is still listed for humans");
    assert.equal(item.deliverable, false);
    assert.equal(item.invokable, false);
    assert.match(item.invokableReason, /disable-model-invocation/);
    assert.equal(
      await resolveSkillForTurn(h.ctx, "manual-only", h.projectDir, {
        id: "user-a",
      }),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.AMIRO_BROWSE_ROOTS;
    else process.env.AMIRO_BROWSE_ROOTS = previous;
    await h.cleanup();
  }
});

test("reported invokability tracks the real tool policy used by chat", () => {
  const previous = {
    trusted: process.env.AMIRO_TRUSTED_OPERATOR,
    profile: process.env.AMIRO_TOOL_PROFILE,
  };
  try {
    delete process.env.AMIRO_TRUSTED_OPERATOR;
    delete process.env.AMIRO_TOOL_PROFILE;
    assert.equal(toolsExposed(), false, "default deployment exposes no tools");
    assert.equal(toolsEnabled(), false, "chat agrees: no tools by default");

    process.env.AMIRO_TRUSTED_OPERATOR = "1";
    assert.equal(toolsExposed(), false, "trusted alone is not enough");
    assert.equal(
      toolsEnabled(),
      false,
      "chat agrees: trusted alone is not enough",
    );

    process.env.AMIRO_TOOL_PROFILE = "full";
    assert.equal(toolsExposed(), true);
    assert.equal(
      toolsEnabled(),
      true,
      "chat agrees: trusted + full exposes tools",
    );
  } finally {
    if (previous.trusted === undefined)
      delete process.env.AMIRO_TRUSTED_OPERATOR;
    else process.env.AMIRO_TRUSTED_OPERATOR = previous.trusted;
    if (previous.profile === undefined) delete process.env.AMIRO_TOOL_PROFILE;
    else process.env.AMIRO_TOOL_PROFILE = previous.profile;
  }
});

test("skill generation is honestly 501 by default and never invents a draft", async () => {
  const h = await makeHarness();
  const previous = process.env.AMIRO_ENABLE_SKILL_GENERATION;
  try {
    delete process.env.AMIRO_ENABLE_SKILL_GENERATION;
    assert.equal(skillGenerationEnabled(), false);

    // The deployed preview contract: POST /api/skills/generate with an empty
    // body must be 501, not a 200 stream carrying a fabricated draft.
    const res = await h.call("POST", "/api/skills/generate", { body: "{}" });
    assert.equal(res.status, 501);
    assert.match(res.body.error, /not enabled/);
    assert.equal(res.frames, undefined, "no stream frames on a refusal");

    // Opted in, a missing message is a client error rather than a fake draft.
    process.env.AMIRO_ENABLE_SKILL_GENERATION = "1";
    const bad = await h.call("POST", "/api/skills/generate", { body: "{}" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /message is required/);
  } finally {
    if (previous === undefined)
      delete process.env.AMIRO_ENABLE_SKILL_GENERATION;
    else process.env.AMIRO_ENABLE_SKILL_GENERATION = previous;
    await h.cleanup();
  }
});
