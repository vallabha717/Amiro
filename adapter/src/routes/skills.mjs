// adapter/src/routes/skills.mjs -- skill catalog CRUD, duplicate, and real
// filesystem skill discovery across ~/.jcode/skills, ~/.codex/skills, and
// project .agents/skills + .jcode/skills.
//
// Two independent storage layers, kept deliberately separate:
//   1. Filesystem discovery (read-only). Real SKILL.md files owned by Jcode,
//      the project, or Codex. Never written to, never deleted.
//   2. User store (read/write, ONE FILE PER USER). `$AMIRO_HOME/store/skills/
//      <userId>.json`. A user can only ever read and mutate their own file, so
//      one signed-in user can never list, edit, duplicate or delete another
//      user's skill.
//
// Safety rules enforced here, all of them load-bearing:
//   - A skill name that can reach the filesystem must match SKILL_NAME_REGEX
//     and be <= 64 chars. That is the only reason `../../x` can never be
//     turned into a mirror path.
//   - Every mirror path is resolved and re-checked for containment under the
//     mirror root before mkdir/write/rm.
//   - The `project` query parameter is validated with the same helper the
//     folder picker uses (realpath + AMIRO_BROWSE_ROOTS containment + deny
//     list). An invalid project is refused, never silently swapped for the
//     repository root.
//   - A SKILL.md whose realpath escapes its own skills root is skipped and
//     reported as an error diagnostic instead of being read.
//
// Honest capability reporting: `deliverable` and `invokable` describe what
// this adapter can actually do with a skill. See describeCapability().

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertUsableProjectDirectory } from "../fsbrowse.mjs";

// Mirrors src/types/skill.ts SKILL_NAME_REGEX / SKILL_NAME_MAX_LENGTH so a name
// that the UI accepts is exactly the name the adapter will write to disk.
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX_LENGTH = 64;

const SKILL_NAME_INVALID_MESSAGE =
  "skill name must be lowercase letters, digits and single hyphens (max 64 characters)";

export function isValidSkillName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= SKILL_NAME_MAX_LENGTH &&
    SKILL_NAME_REGEX.test(name)
  );
}

// Read-only lookups never build a filesystem path from the name, so they only
// need to be free of separators and control characters. Discovered skills may
// legitimately be named things the strict write rule rejects (an underscore,
// for instance); those stay readable but are reported as not invokable.
function isSafeLookupName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 128 &&
    !/[\u0000-\u001f\u007f/\\]/.test(name)
  );
}

function parseSkillMarkdown(raw, fallbackName) {
  const text = String(raw || "");
  let name = fallbackName;
  let description = "";
  let body = text;
  let license;
  let disableModelInvocation = false;
  let allowedTools = [];

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (fmMatch) {
    const fm = fmMatch[1];
    body = fmMatch[2].trim();
    for (const line of fm.split(/\r?\n/)) {
      const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1].toLowerCase().replace(/_/g, "-");
      const val = m[2].replace(/^['"]|['"]$/g, "").trim();
      if (key === "name" && val) name = val;
      if (key === "description" && val) description = val;
      if (key === "license" && val) license = val;
      if (key === "disable-model-invocation" && val)
        disableModelInvocation = val === "true";
      if (key === "allowed-tools" && val) {
        allowedTools = val
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
  }

  if (!description && body) {
    const firstPara = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith("```"));
    if (firstPara) description = firstPara.slice(0, 240);
  }

  return {
    name,
    description,
    body,
    license,
    disableModelInvocation,
    allowedTools,
  };
}

function isContained(baseReal, candidateReal) {
  if (!baseReal || !candidateReal) return false;
  return (
    candidateReal === baseReal ||
    candidateReal.startsWith(`${baseReal}${path.sep}`)
  );
}

async function realpathOrNull(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capability reporting
// ---------------------------------------------------------------------------

// The ONLY invocation this adapter implements is context delivery: chat.mjs
// resolves a mentioned skill name server-side and rides its SKILL.md body into
// the turn as a system reminder. So:
//   deliverable -- the adapter will resolve this name and hand the body to the
//                  turn. Says nothing about the skill running.
//   invokable   -- deliverable AND this server exposes tools for the turn, so
//                  the instructions can actually be acted on. When tools are
//                  off a skill can be read into context but nothing can run.
function describeCapability(skill, toolsExposed) {
  const body = String(skill.body || "").trim();
  if (!body) {
    return {
      deliverable: false,
      invokable: false,
      invokableReason:
        "This SKILL.md has no instructions in its body, so there is nothing to deliver to a turn.",
    };
  }
  if (skill.disableModelInvocation) {
    return {
      deliverable: false,
      invokable: false,
      invokableReason:
        "This SKILL.md sets disable-model-invocation, so the model is not allowed to use it.",
    };
  }
  if (!isValidSkillName(String(skill.name || "").toLowerCase())) {
    return {
      deliverable: false,
      invokable: false,
      invokableReason: `"${skill.name}" is not a valid skill name, so a chat mention cannot resolve it. Only lowercase letters, digits and single hyphens work.`,
    };
  }
  if (!toolsExposed) {
    return {
      deliverable: true,
      invokable: false,
      invokableReason:
        "Mentioning this skill adds its SKILL.md to the turn, but this server runs with tools off, so the skill can be read, not executed.",
    };
  }
  return {
    deliverable: true,
    invokable: true,
    invokableReason:
      "Mentioning this skill adds its SKILL.md to the turn and this server exposes tools, so the model can act on it.",
  };
}

// Mirrors chat.mjs toolProfile(): tools are exposed only for a trusted local
// operator that also opts in to the full profile. Duplicated rather than
// imported so chat.mjs can import resolveSkillForTurn from here without a
// circular import; adapter/test/skills.test.mjs asserts the two stay in sync.
export function toolsExposed() {
  const trusted = process.env.AMIRO_TRUSTED_OPERATOR === "1";
  return trusted && process.env.AMIRO_TOOL_PROFILE === "full";
}

// Model-backed skill drafting is off unless an operator turns it on, so the
// route is honestly 501 in the deployed preview (adapter/test/public-contract.mjs
// and live-smoke.mjs assert exactly that) instead of inventing a draft.
export function skillGenerationEnabled() {
  return process.env.AMIRO_ENABLE_SKILL_GENERATION === "1";
}

// ---------------------------------------------------------------------------
// Filesystem discovery
// ---------------------------------------------------------------------------

function skillsRoots(ctx, repoRoot) {
  const jcodeHome =
    ctx.config.jcodeHome ||
    process.env.JCODE_HOME ||
    path.join(os.homedir(), ".jcode");
  const codexHome = path.join(os.homedir(), ".codex");
  return [
    { dir: path.join(jcodeHome, "skills"), scope: "user", source: ".jcode" },
    {
      dir: path.join(repoRoot, ".jcode", "skills"),
      scope: "project",
      source: ".jcode",
    },
    {
      dir: path.join(repoRoot, ".agents", "skills"),
      scope: "project",
      source: ".agents",
    },
    { dir: path.join(codexHome, "skills"), scope: "user", source: ".codex" },
  ];
}

async function discoverFilesystemSkills(ctx, projectDir, diagnostics) {
  const repoRoot = projectDir || path.resolve(ctx.config.outDir, "..");
  const discovered = new Map();

  for (const root of skillsRoots(ctx, repoRoot)) {
    const rootReal = await realpathOrNull(root.dir);
    if (!rootReal) continue;

    let entries = [];
    try {
      entries = await fs.readdir(rootReal, { withFileTypes: true });
    } catch (err) {
      diagnostics.push({
        path: root.dir,
        severity: "warning",
        message: `Could not read skills directory: ${err && err.message ? err.message : err}`,
      });
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

      const skillDir = path.join(rootReal, entry.name);
      const skillMdPath = path.join(skillDir, "SKILL.md");
      const skillMdReal = await realpathOrNull(skillMdPath);
      if (!skillMdReal) continue; // not a skill directory

      // A SKILL.md that resolves outside its own skills root (a symlink out of
      // the tree, most likely) is refused and surfaced, never read.
      if (!isContained(rootReal, skillMdReal)) {
        diagnostics.push({
          path: skillMdPath,
          skill: entry.name,
          severity: "error",
          message: `SKILL.md resolves to ${skillMdReal}, outside its skills root ${rootReal}. Refusing to read it.`,
        });
        continue;
      }

      let raw = "";
      let stat = null;
      try {
        stat = await fs.stat(skillMdReal);
        if (!stat.isFile()) continue;
        raw = await fs.readFile(skillMdReal, "utf8");
      } catch (err) {
        diagnostics.push({
          path: skillMdPath,
          skill: entry.name,
          severity: "warning",
          message: `Could not read SKILL.md: ${err && err.message ? err.message : err}`,
        });
        continue;
      }

      const parsed = parseSkillMarkdown(raw, entry.name);
      const key = String(entry.name).toLowerCase();
      if (discovered.has(key)) {
        // A nearer root already supplied this name. Keep the first (root order
        // is precedence order) and say so instead of silently dropping one.
        diagnostics.push({
          path: skillMdPath,
          skill: entry.name,
          severity: "info",
          message: `Shadowed by ${discovered.get(key).path}, which takes precedence.`,
        });
        continue;
      }

      let resources = [];
      try {
        const sub = await fs.readdir(skillDir);
        resources = sub.filter((f) => f !== "SKILL.md" && !f.startsWith("."));
      } catch {
        /* resources are optional */
      }

      discovered.set(key, {
        name: entry.name,
        description: parsed.description || "",
        body: parsed.body || raw,
        resources,
        license: parsed.license,
        disableModelInvocation: parsed.disableModelInvocation,
        allowedTools: parsed.allowedTools,
        scope: root.scope,
        source: root.source,
        writable: false,
        readonly: true,
        path: skillMdPath,
        realPath: skillMdReal,
        updatedAt: stat.mtime ? stat.mtime.toISOString() : ctx.nowIso(),
      });
    }
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Per-user store
// ---------------------------------------------------------------------------

// One store file per user id. `skills.json` (the pre-ownership global file) is
// deliberately NOT migrated into any user's list: an ownerless record cannot be
// attributed to a user, so exposing it would be a cross-user leak. It is
// reported as a diagnostic and left on disk untouched.
function storeNameFor(userId) {
  const safe = String(userId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return `skills/${safe || "unknown"}.json`;
}

const LEGACY_STORE_KEY = "skills.json";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function register(app, ctx) {
  const SKILL_NAME_INVALID = SKILL_NAME_INVALID_MESSAGE;

  async function getStoreSkills(userId) {
    const doc = await ctx.store.read(storeNameFor(userId), {});
    return doc && typeof doc === "object" ? doc : {};
  }

  async function mutateStoreSkills(userId, mutate) {
    return ctx.store.update(storeNameFor(userId), {}, (doc) => {
      const out = doc && typeof doc === "object" ? doc : {};
      const next = mutate(out);
      return next === undefined ? out : next;
    });
  }

  async function legacyOwnerlessSkills() {
    try {
      const doc = await ctx.store.read(LEGACY_STORE_KEY, {});
      return doc && typeof doc === "object" ? Object.keys(doc) : [];
    } catch {
      return [];
    }
  }

  function validateProject(project) {
    if (!project) return Promise.resolve(null);
    return assertUsableProjectDirectory(String(project));
  }

  async function getMergedSkills(userId, projectDir) {
    const diagnostics = [];
    const [storeSkills, fsSkills, legacyNames] = await Promise.all([
      getStoreSkills(userId),
      discoverFilesystemSkills(ctx, projectDir, diagnostics),
      legacyOwnerlessSkills(),
    ]);

    if (legacyNames.length) {
      diagnostics.push({
        path: storeNameFor(userId),
        severity: "warning",
        message: `${legacyNames.length} skill(s) in the old global skills.json have no owner and are not shown to any user.`,
      });
    }

    const merged = new Map();

    // The signed-in user's own skills are writable and win over discovery.
    for (const [k, s] of Object.entries(storeSkills)) {
      if (!s || typeof s !== "object") continue;
      const name = String(s.name || k);
      merged.set(String(k).toLowerCase(), {
        name,
        description: s.description || "",
        body: s.body || "",
        resources: Array.isArray(s.resources) ? s.resources : [],
        scope: s.scope === "project" ? "project" : "user",
        source: s.source || ".amiro",
        writable: true,
        readonly: false,
        owned: true,
        path: s.path || `~/.amiro/skills/${name}/SKILL.md`,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt || ctx.nowIso(),
      });
    }

    for (const [k, s] of fsSkills.entries()) {
      if (!merged.has(k)) merged.set(k, s);
    }

    return { storeSkills, fsSkills, merged, diagnostics };
  }

  function presentSummary(skill, toolsOn) {
    const capability = describeCapability(skill, toolsOn);
    return {
      name: skill.name,
      description: skill.description || "",
      scope: skill.scope || "user",
      source: skill.source || ".amiro",
      writable: Boolean(skill.writable),
      readonly: Boolean(skill.readonly),
      disableModelInvocation: Boolean(skill.disableModelInvocation),
      allowedTools: skill.allowedTools,
      deliverable: capability.deliverable,
      invokable: capability.invokable,
      invokableReason: capability.invokableReason,
      path: skill.path || "",
      license: skill.license,
      updatedAt: skill.updatedAt || ctx.nowIso(),
    };
  }

  function presentDetail(skill, toolsOn) {
    return {
      ...presentSummary(skill, toolsOn),
      body: skill.body || "",
      resources: Array.isArray(skill.resources) ? skill.resources : [],
    };
  }

  // GET /api/skills -- this user's writable skills plus discovered read-only ones.
  app.get("/api/skills", async (req, res) => {
    const user = ctx.requireUser(req);
    const url = new URL(req.url, "http://localhost");
    const project = url.searchParams.get("project") || undefined;

    let projectDir;
    try {
      const validated = await validateProject(project);
      projectDir = validated ? validated.resolvedPath : undefined;
    } catch (err) {
      return ctx.error(
        res,
        err.status || 400,
        err.message || "invalid project directory",
      );
    }

    const toolsOn = toolsExposed();
    const { merged, diagnostics } = await getMergedSkills(user.id, projectDir);
    const items = Array.from(merged.values()).map((s) =>
      presentSummary(s, toolsOn),
    );

    ctx.json(res, 200, { items, diagnostics, truncated: false });
  });

  // GET /api/skills/items/:name -- full detail for one skill.
  app.get("/api/skills/items/:name", async (req, res, params) => {
    const user = ctx.requireUser(req);
    const name = decodeURIComponent(params.name);
    if (!isSafeLookupName(name))
      return ctx.error(res, 400, "invalid skill name");

    const url = new URL(req.url, "http://localhost");
    const project = url.searchParams.get("project") || undefined;

    let projectDir;
    try {
      const validated = await validateProject(project);
      projectDir = validated ? validated.resolvedPath : undefined;
    } catch (err) {
      return ctx.error(
        res,
        err.status || 400,
        err.message || "invalid project directory",
      );
    }

    const { merged } = await getMergedSkills(user.id, projectDir);
    const skill = merged.get(name.toLowerCase());
    if (!skill) return ctx.error(res, 404, "skill not found");

    ctx.json(res, 200, presentDetail(skill, toolsExposed()));
  });

  // POST /api/skills -- create a skill for the signed-in user.
  app.post("/api/skills", async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);

    const name = String(body.name || "")
      .trim()
      .toLowerCase();
    if (!name) return ctx.error(res, 400, "skill name is required");
    if (!isValidSkillName(name)) return ctx.error(res, 400, SKILL_NAME_INVALID);

    const storeSkills = await getStoreSkills(user.id);
    if (storeSkills[name])
      return ctx.error(res, 409, `skill ${name} already exists`);

    const now = ctx.nowIso();
    const skill = {
      name,
      description: String(body.description || "").trim(),
      body: String(body.body || "").trim(),
      resources: Array.isArray(body.resources) ? body.resources : [],
      scope: "user",
      source: ".amiro",
      writable: true,
      readonly: false,
      path: `~/.amiro/skills/${name}/SKILL.md`,
      createdAt: now,
      updatedAt: now,
    };

    await mutateStoreSkills(user.id, (doc) => {
      doc[name] = skill;
      return doc;
    });

    const mirror = await writeMirror(name, skill);
    ctx.json(res, 200, {
      skill: presentDetail(skill, toolsExposed()),
      warnings: mirror.warning ? [mirror.warning] : [],
    });
  });

  // PUT /api/skills/items/:name -- update a skill this user owns.
  app.put("/api/skills/items/:name", async (req, res, params) => {
    const user = ctx.requireUser(req);
    const name = decodeURIComponent(params.name).toLowerCase();
    if (!isValidSkillName(name)) return ctx.error(res, 400, SKILL_NAME_INVALID);

    const storeSkills = await getStoreSkills(user.id);
    const skill = storeSkills[name];
    // A discovered (filesystem) skill is never writable, and another user's
    // skill is not visible here at all: both must 404/409 rather than edit.
    if (!skill) {
      const { merged } = await getMergedSkills(user.id);
      if (merged.has(name)) return ctx.error(res, 409, "skill is read-only");
      return ctx.error(res, 404, "skill not found");
    }

    const body = await ctx.readJson(req);
    if (body.description !== undefined)
      skill.description = String(body.description).trim();
    if (body.body !== undefined) skill.body = String(body.body).trim();
    if (body.resources !== undefined && Array.isArray(body.resources))
      skill.resources = body.resources;
    skill.updatedAt = ctx.nowIso();

    await mutateStoreSkills(user.id, (doc) => {
      doc[name] = skill;
      return doc;
    });

    const mirror = await writeMirror(name, skill);
    ctx.json(res, 200, {
      skill: presentDetail(skill, toolsExposed()),
      warnings: mirror.warning ? [mirror.warning] : [],
    });
  });

  // DELETE /api/skills/items/:name -- delete a skill this user owns.
  app.delete("/api/skills/items/:name", async (req, res, params) => {
    const user = ctx.requireUser(req);
    const name = decodeURIComponent(params.name).toLowerCase();
    if (!isValidSkillName(name)) return ctx.error(res, 400, SKILL_NAME_INVALID);

    const storeSkills = await getStoreSkills(user.id);
    if (!storeSkills[name]) {
      const { merged } = await getMergedSkills(user.id);
      if (merged.has(name)) return ctx.error(res, 409, "skill is read-only");
      return ctx.error(res, 404, "skill not found");
    }

    await mutateStoreSkills(user.id, (doc) => {
      delete doc[name];
      return doc;
    });

    const removed = await removeMirror(name);
    ctx.json(res, 200, {
      success: true,
      warnings: removed.warning ? [removed.warning] : [],
    });
  });

  // POST /api/skills/items/:name/duplicate -- copy any visible skill into this
  // user's own writable set.
  app.post("/api/skills/items/:name/duplicate", async (req, res, params) => {
    const user = ctx.requireUser(req);
    const requested = decodeURIComponent(params.name);
    if (!isSafeLookupName(requested))
      return ctx.error(res, 400, "invalid skill name");

    const { storeSkills, merged } = await getMergedSkills(user.id);
    const skill = merged.get(requested.toLowerCase());
    if (!skill) return ctx.error(res, 404, "skill not found");

    const base = String(skill.name || requested)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SKILL_NAME_MAX_LENGTH - 8);
    const stem = isValidSkillName(base) ? base : "skill";

    let copyName = `${stem}-copy`;
    let counter = 1;
    while (
      !isValidSkillName(copyName) ||
      storeSkills[copyName] ||
      merged.has(copyName)
    ) {
      counter += 1;
      copyName = `${stem}-copy-${counter}`;
    }

    const now = ctx.nowIso();
    const duplicate = {
      name: copyName,
      description: skill.description || "",
      body: skill.body || "",
      resources: Array.isArray(skill.resources) ? skill.resources : [],
      scope: "user",
      source: ".amiro",
      writable: true,
      readonly: false,
      path: `~/.amiro/skills/${copyName}/SKILL.md`,
      createdAt: now,
      updatedAt: now,
    };

    await mutateStoreSkills(user.id, (doc) => {
      doc[copyName] = duplicate;
      return doc;
    });

    const mirror = await writeMirror(copyName, duplicate);
    ctx.json(res, 200, {
      skill: presentDetail(duplicate, toolsExposed()),
      warnings: mirror.warning ? [mirror.warning] : [],
    });
  });

  // POST /api/skills/generate -- model-drafted skill.
  //
  // Disabled by default and answered with 501, because this deployment does not
  // offer model-backed skill drafting. The previous implementation caught every
  // failure and still replied 200 with a hand-built "draft", which is exactly
  // the pretend-it-worked behaviour this preview must not have: a user would
  // believe a model wrote instructions that no model ever saw. A trusted local
  // operator can opt in with AMIRO_ENABLE_SKILL_GENERATION=1; then a failed
  // model call is a real error, never a substituted draft.
  app.post("/api/skills/generate", async (req, res) => {
    ctx.requireUser(req);
    if (!skillGenerationEnabled()) {
      return ctx.error(
        res,
        501,
        "Model-drafted skills are not enabled in this deployment",
      );
    }

    const body = await ctx.readJson(req);
    const message = String(body.message || "").trim();
    if (!message) return ctx.error(res, 400, "message is required");

    let draft = null;
    try {
      const prompt = `Generate a single JSON object with exact keys "name" (lowercase, digits, hyphens), "description", and "body" (markdown content) for a skill with this requirement: ${message}. Output only JSON.`;
      const resText = await ctx.jcode.execJson(["run", prompt]);
      if (typeof resText === "string") {
        const jsonMatch = resText.match(/\{[\s\S]*\}/);
        if (jsonMatch) draft = JSON.parse(jsonMatch[0]);
      } else if (resText && typeof resText === "object") {
        draft = resText;
      }
    } catch (err) {
      ctx.log("warn", "skill generation failed", {
        error: String(err && err.message),
      });
      return ctx.error(
        res,
        503,
        "Skill generation failed. Nothing was created.",
      );
    }

    if (!draft || typeof draft !== "object" || !draft.name) {
      return ctx.error(
        res,
        502,
        "The model did not return a usable skill draft.",
      );
    }

    // A model-authored name is never allowed to become a filename unless it
    // passes the same strict rule the write routes enforce.
    const modelName = String(draft.name).trim().toLowerCase();
    if (!isValidSkillName(modelName)) {
      return ctx.error(
        res,
        502,
        `The model returned an unusable skill name (${modelName.slice(0, 80)}). Nothing was created.`,
      );
    }

    const generated = {
      name: modelName,
      description: String(draft.description || "").slice(0, 1024),
      body: String(draft.body || ""),
    };

    const sse = ctx.sse(res);
    const id = "gen_1";
    sse.start(id);
    sse.startStep();
    sse.textStart(id);
    sse.textDelta(id, JSON.stringify(generated));
    sse.textEnd(id);
    sse.finishStep();
    sse.finish({ generated: true });
    sse.done();
  });

  // -------------------------------------------------------------------------
  // Filesystem mirror (the user's own workspace)
  // -------------------------------------------------------------------------

  // Resolve the mirror directory for a name that has ALREADY passed
  // isValidSkillName, then prove the resolved path is still inside the mirror
  // root. Throws a 403-mapped error instead of writing anywhere else.
  async function mirrorPathFor(name) {
    if (!isValidSkillName(name)) {
      const err = new Error(SKILL_NAME_INVALID);
      err.status = 400;
      throw err;
    }
    const root = path.resolve(ctx.config.workspaceDir, "skills");
    const skillDir = path.resolve(root, name);
    if (skillDir !== root && !skillDir.startsWith(`${root}${path.sep}`)) {
      const err = new Error(
        "skill mirror path escapes the workspace skills directory",
      );
      err.status = 403;
      throw err;
    }
    // If anything already exists along the way, its realpath must also stay
    // inside the root, so a pre-planted symlink cannot redirect the write.
    const real =
      (await realpathOrNull(skillDir)) || (await realpathOrNull(root));
    if (real) {
      const rootReal = (await realpathOrNull(root)) || root;
      if (!isContained(rootReal, real)) {
        const err = new Error(
          "skill mirror path resolves outside the workspace skills directory",
        );
        err.status = 403;
        throw err;
      }
    }
    return path.join(skillDir, "SKILL.md");
  }

  async function writeMirror(name, skill) {
    if (!isValidSkillName(name)) {
      return {
        warning: {
          field: "name",
          message: `${SKILL_NAME_INVALID}; saved to your skill store but not mirrored to the workspace.`,
        },
      };
    }
    try {
      const target = await mirrorPathFor(name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const description = String(skill.description || "")
        .replace(/\r?\n/g, " ")
        .trim();
      const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n${skill.body || ""}\n`;
      await fs.writeFile(target, md, "utf8");
      return { target };
    } catch (err) {
      ctx.log("warn", "failed to mirror skill to workspace", {
        name,
        error: String(err && err.message),
      });
      return {
        warning: {
          field: "path",
          message: `Saved to your skill store, but writing the workspace mirror failed: ${err && err.message ? err.message : err}`,
        },
      };
    }
  }

  async function removeMirror(name) {
    if (!isValidSkillName(name)) return {};
    try {
      const target = await mirrorPathFor(name);
      await fs.rm(path.dirname(target), { recursive: true, force: true });
      return {};
    } catch (err) {
      ctx.log("warn", "failed to remove skill mirror from workspace", {
        name,
        error: String(err && err.message),
      });
      return {
        warning: {
          field: "path",
          message: `Removed from your skill store, but deleting the workspace mirror failed: ${err && err.message ? err.message : err}`,
        },
      };
    }
  }
}

// Server-side mention resolution for the chat adapter: `(ctx, name, projectDir,
// user)`. Returns null unless the name resolves to a catalog entry this user can
// see AND the entry can be delivered. The client only ever supplies a NAME; the
// body is read from the catalog above, so a mention can never read an arbitrary
// path. `user` may be the request user object or a bare user id.
export async function resolveSkillForTurn(ctx, name, projectDir, user) {
  const userId = user && typeof user === "object" ? user.id : user;
  const wanted = String(name || "")
    .trim()
    .toLowerCase();
  if (!isSafeLookupName(wanted) || !isValidSkillName(wanted)) return null;

  const diagnostics = [];
  let storeSkills = {};
  try {
    const safe = String(userId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const doc = await ctx.store.read(`skills/${safe || "unknown"}.json`, {});
    storeSkills = doc && typeof doc === "object" ? doc : {};
  } catch {
    /* a user with no store file yet simply has no writable skills */
  }

  const merged = new Map();
  for (const [k, s] of Object.entries(storeSkills)) {
    if (!s || typeof s !== "object") continue;
    merged.set(String(k).toLowerCase(), {
      name: String(s.name || k),
      description: s.description || "",
      body: s.body || "",
      scope: "user",
      source: s.source || ".amiro",
      path: s.path || "",
    });
  }
  for (const [k, s] of (
    await discoverFilesystemSkills(ctx, projectDir, diagnostics)
  ).entries()) {
    if (!merged.has(k)) merged.set(k, s);
  }

  const skill = merged.get(wanted);
  if (!skill) return null;
  const capability = describeCapability(skill, toolsExposed());
  if (!capability.deliverable) return null;
  return {
    name: String(skill.name),
    description: String(skill.description || ""),
    body: String(skill.body || ""),
    path: String(skill.path || ""),
    scope: skill.scope || "user",
    source: skill.source || ".amiro",
    invokable: capability.invokable,
  };
}
