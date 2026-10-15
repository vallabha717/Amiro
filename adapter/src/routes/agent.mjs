// adapter/src/routes/agent.mjs -- Agent identity, personality, Jcode memory graph,
// and Jcode workspace file browser routes.
//
// Security posture (2026-10-15 hardening):
//   - Identity/personality are per-user (agent-identity/<userId>.json) to prevent
//     cross-user persona clobbering. Legacy shared key is migrated read-only.
//     Persona markdown is written only under ctx.config.workspaceDir/users/<userId>/
//     never to global ~/.jcode/memory/*.json or global prompt-overlay.md.
//   - Jcode native memory graph (~/.jcode/memory/*.json) is READ ONLY via adapter.
//     GET /api/agent/memory is admin-gated and returns readOnly:true. POST /
//     reinforce / DELETE return 501 (readOnly) instead of mutating JSON.
//   - Workspace browser is admin-gated and allowlisted with realpath containment,
//     forbidding secrets/credentials/sessions and arbitrary ~/.jcode files.
//   - Identity/personality inputs are strictly validated (name/traits/accent/image).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const LEGACY_IDENTITY_KEY = 'agent-identity.json';
const IDENTITY_DIR = 'agent-identity';

const ACCENT_PALETTE = {
  green: '#4C9B50',
  orange: '#E9642F',
  pink: '#DB4B77',
  purple: '#A665C9',
  teal: '#0E9B8B',
  yellow: '#E9C91A',
  indigo: '#5856D6',
  cobalt: '#007AFF',
};

const VALID_BODY_SHAPES = new Set(['blob', 'cloud', 'sprout', 'star', 'ghost', 'urchin']);
const VALID_EYE_STYLES = new Set(['grumpy', 'angry', 'curious', 'goofy', 'surprised', 'bashful', 'gentle', 'quirky', 'dazed']);
const VALID_COLORS = new Set(['green', 'orange', 'pink', 'purple', 'teal', 'yellow', 'indigo', 'cobalt']);
// legacy invalid eyeStyle -> canonical mapping
const LEGACY_EYE_MAP = { round: 'grumpy', happy: 'bashful', sleepy: 'gentle', wink: 'quirky' };

const DEFAULT_SLIDERS = {
  companionCoworker: 65,
  genzBoomer: 42,
  executeCollaborate: 35,
  playfulSerious: 55,
  politeUnfiltered: 60,
};

const DEFAULT_TRAITS = {
  bodyShape: 'blob',
  eyeStyle: 'grumpy',
  color: 'orange',
};

const MAX_NAME_LEN = 32;
const MAX_TAGLINE_LEN = 120;
const MAX_HANDLE_LEN = 32;
const MAX_CUSTOM_IMAGE_LEN = 2 * 1024 * 1024; // 2MB base64
const VALID_HANDLE_RE = /^@[a-z0-9_]{1,32}$/i;
const VALID_HEX_RE = /^#[0-9a-fA-F]{6}$/;

function clampSlider(n, fallback = 50) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function normalizeSliders(raw = {}) {
  return {
    companionCoworker: clampSlider(raw.companionCoworker, DEFAULT_SLIDERS.companionCoworker),
    genzBoomer: clampSlider(raw.genzBoomer, DEFAULT_SLIDERS.genzBoomer),
    executeCollaborate: clampSlider(raw.executeCollaborate, DEFAULT_SLIDERS.executeCollaborate),
    playfulSerious: clampSlider(raw.playfulSerious, DEFAULT_SLIDERS.playfulSerious),
    politeUnfiltered: clampSlider(raw.politeUnfiltered, DEFAULT_SLIDERS.politeUnfiltered),
  };
}

function sanitizeUserId(userId) {
  const s = String(userId || '').trim();
  // allow uuid / alphanumeric with -_
  const safe = s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return safe || null;
}

function identityKeyForUser(userId) {
  const safe = sanitizeUserId(userId);
  if (!safe) return LEGACY_IDENTITY_KEY;
  return path.posix.join(IDENTITY_DIR, `${safe}.json`);
}

function normalizeTraits(raw = {}) {
  let bodyShape = String(raw.bodyShape || DEFAULT_TRAITS.bodyShape).trim().toLowerCase();
  let eyeStyle = String(raw.eyeStyle || DEFAULT_TRAITS.eyeStyle).trim().toLowerCase();
  let color = String(raw.color || DEFAULT_TRAITS.color).trim().toLowerCase();
  if (LEGACY_EYE_MAP[eyeStyle]) eyeStyle = LEGACY_EYE_MAP[eyeStyle];
  if (!VALID_BODY_SHAPES.has(bodyShape)) bodyShape = DEFAULT_TRAITS.bodyShape;
  if (!VALID_EYE_STYLES.has(eyeStyle)) eyeStyle = DEFAULT_TRAITS.eyeStyle;
  if (!VALID_COLORS.has(color)) color = DEFAULT_TRAITS.color;
  return { bodyShape, eyeStyle, color };
}

export function summarizePersonality(sliders = DEFAULT_SLIDERS) {
  const s = normalizeSliders(sliders);
  const parts = [];
  const axes = [
    ['companionCoworker', 'Companion', 'Coworker'],
    ['executeCollaborate', 'Independent', 'Collaborative'],
    ['playfulSerious', 'Playful', 'Serious'],
    ['politeUnfiltered', 'Polite', 'Unfiltered'],
    ['genzBoomer', 'Gen Z', 'Classic'],
  ];
  for (const [id, left, right] of axes) {
    const val = s[id] ?? 50;
    const lean = val - 50;
    if (Math.abs(lean) > 6) {
      const pct = lean > 0 ? val : 100 - val;
      const pole = lean > 0 ? right : left;
      parts.push(`${pct}% ${pole}`);
    }
  }
  if (!parts.length) return 'Balanced across all five axes';
  return parts.slice(0, 3).join(' · ');
}

export function buildPersonaPromptBlock(identity) {
  const name = identity?.name || 'Amiro';
  const handle = identity?.handle || '@amiro';
  const summary = identity?.personalitySummary || summarizePersonality(identity?.sliders);
  const s = normalizeSliders(identity?.sliders);
  return [
    `# Agent Identity & Persona (${name} / ${handle})`,
    `- **Name:** ${name}`,
    `- **Personality:** ${summary}`,
    `- **Trait Calibration (0-100):**`,
    `  - Companion (${100 - s.companionCoworker}) vs Coworker (${s.companionCoworker})`,
    `  - Gen Z (${100 - s.genzBoomer}) vs Baby Boomer (${s.genzBoomer})`,
    `  - Execute Independently (${100 - s.executeCollaborate}) vs Collaborative (${s.executeCollaborate})`,
    `  - Playful (${100 - s.playfulSerious}) vs Serious (${s.playfulSerious})`,
    `  - Polite (${100 - s.politeUnfiltered}) vs Unfiltered (${s.politeUnfiltered})`,
  ].join('\n');
}

export function personaFingerprint(identity) {
  const s = normalizeSliders(identity?.sliders || {});
  const payload = JSON.stringify({
    name: String(identity?.name || 'Amiro'),
    handle: String(identity?.handle || '@amiro'),
    traits: normalizeTraits(identity?.traits || {}),
    sliders: s,
    updatedAt: String(identity?.updatedAt || ''),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export async function getAgentIdentity(ctx, userId) {
  const uid = sanitizeUserId(userId);
  let saved = null;
  if (uid) {
    saved = await ctx.store.read(identityKeyForUser(uid), null);
    // migrate legacy shared key once per user if per-user missing
    if (!saved) {
      const legacy = await ctx.store.read(LEGACY_IDENTITY_KEY, null);
      if (legacy) saved = legacy;
    }
  } else {
    saved = await ctx.store.read(LEGACY_IDENTITY_KEY, null);
  }
  const traits = normalizeTraits(saved?.traits || DEFAULT_TRAITS);
  const sliders = normalizeSliders(saved?.sliders || DEFAULT_SLIDERS);
  const accentHex =
    saved?.accentHex && VALID_HEX_RE.test(String(saved.accentHex))
      ? String(saved.accentHex)
      : ACCENT_PALETTE[traits.color] || ACCENT_PALETTE.orange;
  const name = String(saved?.name || 'Amiro').trim() || 'Amiro';
  const handleRaw = String(saved?.handle || `@${name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'amiro'}`).trim();
  const handle = VALID_HANDLE_RE.test(handleRaw) ? handleRaw : `@${name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'amiro'}`;
  const personalitySummary = saved?.personalitySummary || summarizePersonality(sliders);
  // normalize customImageUrl length / prefix
  let customImageUrl = saved?.customImageUrl ?? null;
  if (customImageUrl != null) {
    const s = String(customImageUrl);
    if (s.length > MAX_CUSTOM_IMAGE_LEN) customImageUrl = null;
    else if (s.startsWith('data:image/')) {
      if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s.slice(0, 2000)) && s.length > 22) {
        // allow but length checked; strict prefix check for data uri
        if (!s.startsWith('data:image/')) customImageUrl = null;
      }
    } else if (s.startsWith('http://') || s.startsWith('https://')) {
      try { new URL(s); } catch { customImageUrl = null; }
    } else if (s !== '') {
      // only allow data: or https
      customImageUrl = null;
    }
    if (customImageUrl === '') customImageUrl = null;
  }
  return {
    name: name.slice(0, MAX_NAME_LEN),
    handle: handle.slice(0, MAX_HANDLE_LEN + 1),
    tagline: String(saved?.tagline || 'Your Personal Intelligence powered by Jcode').slice(0, MAX_TAGLINE_LEN) || 'Your Personal Intelligence powered by Jcode',
    traits,
    accentHex,
    customImageUrl: customImageUrl || null,
    sliders,
    personalitySummary,
    updatedAt: saved?.updatedAt || ctx.nowIso(),
  };
}

function validateIdentityPayload(body) {
  const errors = [];
  if (body?.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) errors.push('name must not be empty');
    else if (n.length > MAX_NAME_LEN) errors.push(`name must be <= ${MAX_NAME_LEN} chars`);
    else if (/[\x00-\x1f]/.test(n)) errors.push('name contains control characters');
  }
  if (body?.handle !== undefined) {
    const h = String(body.handle).trim();
    if (h && !VALID_HANDLE_RE.test(h)) errors.push('handle must be @alphanumeric (1-32 chars)');
    if (h.length > MAX_HANDLE_LEN + 1) errors.push('handle too long');
  }
  if (body?.tagline !== undefined) {
    const t = String(body.tagline).trim();
    if (t.length > MAX_TAGLINE_LEN) errors.push(`tagline must be <= ${MAX_TAGLINE_LEN} chars`);
  }
  if (body?.traits !== undefined) {
    const tr = body.traits || {};
    if (tr.bodyShape !== undefined && !VALID_BODY_SHAPES.has(String(tr.bodyShape).toLowerCase())) {
      errors.push(`traits.bodyShape must be one of ${Array.from(VALID_BODY_SHAPES).join(', ')}`);
    }
    let eye = String(tr.eyeStyle || '').toLowerCase();
    if (LEGACY_EYE_MAP[eye]) eye = LEGACY_EYE_MAP[eye];
    if (tr.eyeStyle !== undefined && !VALID_EYE_STYLES.has(eye)) {
      errors.push(`traits.eyeStyle must be one of ${Array.from(VALID_EYE_STYLES).join(', ')}`);
    }
    if (tr.color !== undefined && !VALID_COLORS.has(String(tr.color).toLowerCase())) {
      errors.push(`traits.color must be one of ${Array.from(VALID_COLORS).join(', ')}`);
    }
  }
  if (body?.accentHex !== undefined && body.accentHex !== null && body.accentHex !== '') {
    if (!VALID_HEX_RE.test(String(body.accentHex))) errors.push('accentHex must be #RRGGBB');
  }
  if (body?.customImageUrl !== undefined && body.customImageUrl !== null && body.customImageUrl !== '') {
    const v = String(body.customImageUrl);
    if (v.length > MAX_CUSTOM_IMAGE_LEN) errors.push(`customImageUrl must be <= ${MAX_CUSTOM_IMAGE_LEN} chars`);
    else if (v.startsWith('data:')) {
      if (!v.startsWith('data:image/')) errors.push('customImageUrl data URI must be data:image/*;base64,');
      else if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v.slice(0, 5000)) && v.length > 22) {
        // allow up to 2MB, regex limited to prefix check
        if (!v.includes(';base64,')) errors.push('customImageUrl data URI must contain ;base64,');
      }
    } else if (v.startsWith('http://') || v.startsWith('https://')) {
      try { new URL(v); } catch { errors.push('customImageUrl must be a valid URL'); }
      if (v.length > 2048) errors.push('customImageUrl URL too long');
    } else {
      errors.push('customImageUrl must be https:// or data:image/*;base64,');
    }
  }
  if (body?.sliders !== undefined) {
    const s = body.sliders || {};
    for (const k of Object.keys(DEFAULT_SLIDERS)) {
      if (s[k] !== undefined) {
        const n = Number(s[k]);
        if (!Number.isFinite(n) || n < 0 || n > 100) errors.push(`sliders.${k} must be 0-100`);
      }
    }
    const extra = Object.keys(s).filter(k => !(k in DEFAULT_SLIDERS));
    if (extra.length) errors.push(`unknown slider keys: ${extra.join(', ')}`);
  }
  return errors;
}

async function syncPersonaFiles(ctx, identity, userId) {
  try {
    const uid = sanitizeUserId(userId);
    if (!uid) return;
    // Per-user directory only; never writes to shared prompt-overlay.md or global memory
    const wsDir = path.join(ctx.config.workspaceDir, 'users', uid);
    await fs.mkdir(wsDir, { recursive: true });
    const identityMd = [
      `# Identity`,
      ``,
      `- **Name:** ${identity.name}`,
      `- **Handle:** ${identity.handle}`,
      `- **Tagline:** ${identity.tagline}`,
      `- **Personality:** ${identity.personalitySummary}`,
      `- **Avatar:** ${identity.traits.bodyShape} · ${identity.traits.eyeStyle} · ${identity.traits.color} (${identity.accentHex})`,
      `- **Updated:** ${identity.updatedAt}`,
      ``,
    ].join('\n');

    const s = normalizeSliders(identity.sliders);
    const soulMd = [
      `# Soul & Behavioral Calibration`,
      ``,
      `You are **${identity.name}** (${identity.handle}), a Personal Intelligence running on the Jcode harness.`,
      ``,
      `## Voice & Trait Calibration`,
      `- **Role (${s.companionCoworker >= 50 ? 'Coworker-leaning' : 'Companion-leaning'}):** ${100 - s.companionCoworker}% Companion / ${s.companionCoworker}% Coworker`,
      `- **Generation Tone:** ${100 - s.genzBoomer}% Gen Z / ${s.genzBoomer}% Classic`,
      `- **Autonomy (${s.executeCollaborate <= 50 ? 'Execute Independently' : 'Collaborative'}):** ${100 - s.executeCollaborate}% Independent / ${s.executeCollaborate}% Collaborative`,
      `- **Demeanor:** ${100 - s.playfulSerious}% Playful / ${s.playfulSerious}% Serious`,
      `- **Candor:** ${100 - s.politeUnfiltered}% Polite / ${s.politeUnfiltered}% Unfiltered`,
      ``,
      `## Operating Principles`,
      `- Stay direct, grounded in verified measurements, and aligned with your guardian's goals.`,
      `- Draw on Jcode's local memory graph and installed Superpowers (skills) whenever relevant.`,
      ``,
    ].join('\n');

    await fs.writeFile(path.join(wsDir, 'IDENTITY.md'), identityMd, 'utf8');
    await fs.writeFile(path.join(wsDir, 'SOUL.md'), soulMd, 'utf8');

    // Per-user prompt overlay inside workspaceDir/users/<uid>/prompt-overlay.md
    // Intentionally NOT writing to ctx.config.home/prompt-overlay.md (global overlay)
    // to avoid cross-user prompt injection. Chat worker reads per-user overlay via
    // getAgentIdentity -> buildPersonaPromptBlock + sendSystemReminder.
    const overlayPath = path.join(wsDir, 'prompt-overlay.md');
    await fs.writeFile(overlayPath, `${buildPersonaPromptBlock(identity)}\n`, 'utf8');
  } catch (err) {
    ctx.log('warn', 'failed to sync persona markdown files', { error: String(err && err.message) });
  }
}

// ---------------------------------------------------------------------------
// Jcode Memory Graph Reader (READ ONLY) (~/.jcode/memory/*.json)
// ---------------------------------------------------------------------------

function resolveJcodeHome(ctx) {
  return ctx.config.jcodeHome || process.env.JCODE_HOME || path.join(os.homedir(), '.jcode');
}

function resolveMemoryDir(ctx) {
  return path.join(resolveJcodeHome(ctx), 'memory');
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function emptyMemoryGraph() {
  return {
    graph_version: 2,
    memories: {},
    tags: {},
    clusters: [],
    edges: {},
    reverse_edges: {},
    metadata: { retrieval_count: 0, link_discovery_count: 0 },
  };
}

async function loadAllMemoryGraphs(ctx) {
  const memDir = resolveMemoryDir(ctx);
  const globalPath = path.join(memDir, 'global.json');
  const projectsDir = path.join(memDir, 'projects');

  const scopes = [];
  const memories = [];
  const explicitEdges = [];
  const allTags = new Set();
  const byCategory = {};

  async function ingestGraphFile(filePath, scopeId, scopeKind, scopeLabel) {
    let stat = null;
    try {
      stat = await fs.stat(filePath);
    } catch {
      if (scopeKind !== 'global') return;
    }
    const doc = await readJsonSafe(filePath, emptyMemoryGraph());
    const rawMemories = doc?.memories || {};
    const entries = Array.isArray(rawMemories)
      ? rawMemories
      : Object.values(rawMemories);

    let activeInScope = 0;
    for (const m of entries) {
      if (!m || typeof m !== 'object') continue;
      const active = m.active !== false && !m.superseded_by;
      if (active) activeInScope += 1;
      const category = String(m.category || 'fact').toLowerCase();
      if (active) {
        byCategory[category] = (byCategory[category] || 0) + 1;
      }
      const tags = Array.isArray(m.tags) ? m.tags.map(String) : [];
      for (const t of tags) allTags.add(t);
      const reinforcementsCount = Array.isArray(m.reinforcements)
        ? m.reinforcements.length
        : Number(m.reinforcements || 0);

      memories.push({
        id: String(m.id || `mem_${crypto.randomUUID()}`),
        content: String(m.content || ''),
        category,
        scope: scopeId,
        scopeKind,
        scopeLabel,
        tags,
        source: String(m.source || 'local'),
        trust: String(m.trust || 'high'),
        strength: Number(m.strength ?? 1),
        confidence: Number(m.confidence ?? 1),
        accessCount: Number(m.access_count ?? 0),
        reinforcements: reinforcementsCount,
        active,
        createdAt: m.created_at || m.createdAt || stat?.mtime?.toISOString() || ctx.nowIso(),
        updatedAt: m.updated_at || m.updatedAt || stat?.mtime?.toISOString() || ctx.nowIso(),
      });
    }

    const rawEdges = doc?.edges || {};
    if (rawEdges && typeof rawEdges === 'object') {
      for (const [fromId, targets] of Object.entries(rawEdges)) {
        const list = Array.isArray(targets) ? targets : Object.keys(targets || {});
        for (const t of list) {
          const toId = typeof t === 'string' ? t : t?.target || t?.to;
          if (fromId && toId) {
            explicitEdges.push({
              id: `${fromId}->${toId}`,
              source: fromId,
              target: toId,
              kind: 'explicit',
              label: typeof t === 'object' && t?.kind ? String(t.kind) : 'linked',
            });
          }
        }
      }
    }

    if (doc?.tags && typeof doc.tags === 'object' && !Array.isArray(doc.tags)) {
      for (const tagKey of Object.keys(doc.tags)) allTags.add(tagKey);
    }

    scopes.push({
      id: scopeId,
      label: scopeLabel,
      kind: scopeKind,
      file: path.relative(resolveJcodeHome(ctx), filePath),
      count: activeInScope,
      updatedAt: stat?.mtime ? stat.mtime.toISOString() : null,
    });
  }

  await ingestGraphFile(globalPath, 'global', 'global', 'Global Memory');

  try {
    const files = await fs.readdir(projectsDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();
    for (const file of jsonFiles) {
      const hash = file.replace(/\.json$/, '');
      const full = path.join(projectsDir, file);
      await ingestGraphFile(full, hash, 'project', `Project ${hash.slice(0, 8)}`);
    }
  } catch {
    // No projects directory yet
  }

  memories.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));

  const activeMemories = memories.filter((m) => m.active);
  const edgeMap = new Map();
  for (const e of explicitEdges) {
    edgeMap.set(e.id, e);
  }

  const byTag = new Map();
  for (const m of activeMemories) {
    for (const tag of m.tags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(m.id);
    }
  }
  for (const [tag, ids] of byTag.entries()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < Math.min(ids.length, i + 4); j++) {
        const key = `${ids[i]}<->${ids[j]}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            id: key,
            source: ids[i],
            target: ids[j],
            kind: 'tag',
            label: `#${tag}`,
          });
        }
      }
    }
  }

  const byCat = new Map();
  for (const m of activeMemories) {
    if (!byCat.has(m.category)) byCat.set(m.category, []);
    byCat.get(m.category).push(m);
  }
  for (const [cat, list] of byCat.entries()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (i + 1 < list.length) {
        const b = list[i + 1];
        const key = `cat:${a.id}->${b.id}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            id: key,
            source: a.id,
            target: b.id,
            kind: 'category',
            label: cat,
          });
        }
      }
    }
  }

  return {
    stats: {
      total: activeMemories.length,
      allRecords: memories.length,
      active: activeMemories.length,
      superseded: memories.length - activeMemories.length,
      projectCount: activeMemories.filter((m) => m.scopeKind === 'project').length,
      globalCount: activeMemories.filter((m) => m.scopeKind === 'global').length,
      uniqueTags: allTags.size,
      byCategory,
    },
    scopes,
    memories: activeMemories,
    edges: Array.from(edgeMap.values()),
  };
}

// ---------------------------------------------------------------------------
// Workspace File Browser Helpers (admin-gated, allowlisted, realpath-contained)
// ---------------------------------------------------------------------------

function getWorkspaceRoots(ctx) {
  const jcodeHome = resolveJcodeHome(ctx);
  const amiroWorkspace = ctx.config.workspaceDir;
  const repoRoot = path.resolve(ctx.config.outDir, '..');
  return [
    {
      id: 'jcode',
      label: 'Jcode Memory & Skills (~/.jcode)',
      basePath: jcodeHome,
      description: 'Live Jcode memory graph JSONs, installed skills, and prompt overlays (read-only)',
    },
    {
      id: 'amiro',
      label: 'Agent Identity (IDENTITY.md & SOUL.md)',
      basePath: amiroWorkspace,
      description: 'Your agent persona files, SOUL.md calibration, and workspace scratchpad',
    },
    {
      id: 'project',
      label: 'Active Project (Amiro)',
      basePath: repoRoot,
      description: 'Current repository source tree and documentation',
    },
  ];
}

const BLOCKED_WORKSPACE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'auth.json',
  'credentials.json',
  'users.json',
  'sessions.json',
  'admin-initial-password',
  'keys.enc',
  'node_modules',
  '.git',
  '.next',
  'openai-auth.json',
  'openai_oauth_usage.json',
  'antigravity_oauth.json',
  'auth-refresh-state.json',
  'servers.json',
]);

function isBlockedWorkspacePath(relPath) {
  const parts = String(relPath || '')
    .split(/[\\/]+/)
    .filter(Boolean);
  for (const part of parts) {
    if (BLOCKED_WORKSPACE_NAMES.has(part)) return true;
    if (part === '.jcode' || part === '.ssh' || part === '.aws' || part === '.gnupg') return true;
    if (part.endsWith('.env') || part.endsWith('.key') || part.endsWith('.pem') || part.endsWith('.sock')) {
      return true;
    }
  }
  // forbid any path that touches sessions/credentials at top level
  const lower = String(relPath || '').toLowerCase();
  if (lower.includes('/sessions/') || lower.startsWith('sessions/')) return true;
  if (lower.includes('/client_sessions/') || lower.startsWith('client_sessions/')) return true;
  if (lower.includes('/pending-login/') || lower.startsWith('pending-login/')) return true;
  return false;
}

// Allowlist for each root: only these relative posix paths are readable
function isAllowedWorkspaceRel(rootId, relPosix) {
  const rel = String(relPosix || '').replace(/^\/+/, '').split(path.sep).join('/');
  if (rel === '' || rel === '.') return true; // listing root itself
  if (isBlockedWorkspacePath(rel)) return false;
  if (rootId === 'jcode') {
    if (rel === 'prompt-overlay.md') return true;
    if (rel === 'config.toml') return true;
    if (rel.startsWith('memory/')) return true;
    if (rel.startsWith('skills/')) return true;
    return false;
  }
  if (rootId === 'amiro') {
    if (rel === 'IDENTITY.md' || rel === 'SOUL.md' || rel === 'prompt-overlay.md') return true;
    if (rel.startsWith('users/')) {
      const parts = rel.split('/');
      // users/<userId>/IDENTITY.md etc.
      if (parts.length === 3 && ['IDENTITY.md', 'SOUL.md', 'prompt-overlay.md'].includes(parts[2])) return true;
      return false;
    }
    if (rel.startsWith('skills/')) return true;
    return false;
  }
  if (rootId === 'project') {
    // project root is more permissive but still blocks sensitive names via isBlocked
    // also forbid arbitrary ~/.jcode references
    if (rel.includes('..')) return false;
    return true;
  }
  return false;
}

function isWritableWorkspaceRel(rootId, relPosix, userId) {
  const rel = String(relPosix || '').replace(/^\/+/, '').split(path.sep).join('/');
  if (!rel) return false;
  if (rootId === 'jcode') return false; // jcode is read-only via workspace
  if (rootId === 'amiro') {
    const uid = sanitizeUserId(userId);
    if (uid && rel === `users/${uid}/IDENTITY.md`) return true;
    if (uid && rel === `users/${uid}/SOUL.md`) return true;
    if (uid && rel === `users/${uid}/prompt-overlay.md`) return true;
    // legacy top-level persona files: allow only for admin migrating? deny by default to enforce per-user
    // skills under amiro are managed via /api/skills, not workspace
    return false;
  }
  if (rootId === 'project') return false; // project writes not via agent workspace
  return false;
}

async function resolveContainedWorkspacePath(baseDir, relPath = '', opts = {}) {
  const { rootId, userId, forWrite } = opts;
  const cleanRelInput = String(relPath || '').replace(/^\/+/, '');
  const posixRel = cleanRelInput.split(path.sep).join('/');
  // allowlist check first (before filesystem touch)
  if (posixRel && !isAllowedWorkspaceRel(rootId, posixRel)) {
    const err = new Error(forWrite ? 'file is read-only or not allowlisted' : 'access to this file is not allowed');
    err.status = 403;
    throw err;
  }
  if (isBlockedWorkspacePath(cleanRelInput)) {
    const err = new Error('access to sensitive file is not allowed');
    err.status = 403;
    throw err;
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, cleanRelInput);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) {
    const err = new Error('path traversal is not allowed');
    err.status = 403;
    throw err;
  }
  // realpath containment: resolve symlinks for base and target's existing parent
  let realBase;
  try {
    realBase = await fs.realpath(resolvedBase);
  } catch {
    realBase = resolvedBase;
  }
  // Check target realpath if exists, otherwise parent
  let realTarget = resolvedTarget;
  try {
    realTarget = await fs.realpath(resolvedTarget);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // check parent realpath
      try {
        const parentReal = await fs.realpath(path.dirname(resolvedTarget));
        realTarget = path.join(parentReal, path.basename(resolvedTarget));
      } catch {
        realTarget = resolvedTarget;
      }
    } else {
      throw e;
    }
  }
  const effectiveBase = realBase;
  if (realTarget !== effectiveBase && !realTarget.startsWith(`${effectiveBase}${path.sep}`)) {
    const err = new Error('path traversal via symlink is not allowed');
    err.status = 403;
    throw err;
  }
  // re-check allowlist against realTarget relative
  const realRel = path.relative(effectiveBase, realTarget).split(path.sep).join('/');
  if (realRel && realRel !== '.' && !isAllowedWorkspaceRel(rootId, realRel)) {
    const err = new Error('access to this file is not allowed');
    err.status = 403;
    throw err;
  }
  if (isBlockedWorkspacePath(realRel)) {
    const err = new Error('access to sensitive file is not allowed');
    err.status = 403;
    throw err;
  }
  if (forWrite && !isWritableWorkspaceRel(rootId, realRel, userId)) {
    const err = new Error('file is read-only');
    err.status = 403;
    throw err;
  }
  const cleanRel = path.relative(resolvedBase, resolvedTarget).split(path.sep).join('/');
  return { resolvedBase, resolvedTarget: realTarget, cleanRel: cleanRel === '' ? '' : cleanRel, realRel };
}

function detectLanguage(ext) {
  switch (ext.toLowerCase()) {
    case '.md':
    case '.mdx':
      return 'markdown';
    case '.json':
      return 'json';
    case '.toml':
      return 'toml';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.mjs':
      return 'javascript';
    case '.css':
      return 'css';
    default:
      return 'text';
  }
}

function requireAdmin(req, res, ctx) {
  const user = ctx.requireUser(req);
  if (!user || user.role !== 'admin') {
    ctx.error(res, 403, 'Forbidden: admin required');
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function register(app, ctx) {
  // GET /api/agent/identity -- per-user agent identity, avatar, personality
  app.get('/api/agent/identity', async (req, res) => {
    const user = ctx.requireUser(req);
    const identity = await getAgentIdentity(ctx, user.id);
    // Only admin gets machine memory stats; non-admin gets identity alone to avoid leaking shared machine state
    if (user.role === 'admin') {
      const memGraph = await loadAllMemoryGraphs(ctx).catch(() => ({ stats: { total: 0, active: 0, superseded: 0, projectCount: 0, globalCount: 0, uniqueTags: 0, byCategory: {} } }));
      ctx.json(res, 200, {
        ...identity,
        memoryStats: memGraph.stats,
        fingerprint: personaFingerprint(identity),
      });
    } else {
      ctx.json(res, 200, {
        ...identity,
        fingerprint: personaFingerprint(identity),
      });
    }
  });

  // PUT /api/agent/identity -- per-user update with strict validation
  app.put('/api/agent/identity', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const errors = validateIdentityPayload(body);
    if (errors.length) return ctx.error(res, 400, errors.join('; '));
    const current = await getAgentIdentity(ctx, user.id);

    const nextTraits = body?.traits
      ? normalizeTraits({ ...current.traits, ...body.traits })
      : current.traits;
    const nextSliders = body?.sliders ? normalizeSliders(body.sliders) : current.sliders;
    const nextName =
      body?.name !== undefined ? String(body.name).trim() || current.name : current.name;
    const nextHandle =
      body?.handle !== undefined
        ? String(body.handle).trim() || `@${nextName.toLowerCase().replace(/[^a-z0-9]+/g, '')}`
        : `@${nextName.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'amiro'}`;
    if (nextHandle && !VALID_HANDLE_RE.test(nextHandle)) {
      return ctx.error(res, 400, 'handle must be @alphanumeric (1-32 chars)');
    }
    const nextAccent =
      body?.accentHex !== undefined
        ? (body.accentHex && VALID_HEX_RE.test(String(body.accentHex)) ? String(body.accentHex) : ACCENT_PALETTE[nextTraits.color] || current.accentHex)
        : ACCENT_PALETTE[nextTraits.color] || current.accentHex;

    let nextImage = current.customImageUrl;
    if (body?.customImageUrl !== undefined) {
      if (body.customImageUrl === null || body.customImageUrl === '') nextImage = null;
      else nextImage = String(body.customImageUrl);
      if (nextImage && nextImage.length > MAX_CUSTOM_IMAGE_LEN) {
        return ctx.error(res, 400, 'customImageUrl too large (max 2MB)');
      }
    }

    const updated = {
      name: String(nextName).slice(0, MAX_NAME_LEN),
      handle: String(nextHandle).slice(0, MAX_HANDLE_LEN + 1),
      tagline:
        body?.tagline !== undefined ? String(body.tagline).trim().slice(0, MAX_TAGLINE_LEN) : String(current.tagline).slice(0, MAX_TAGLINE_LEN),
      traits: nextTraits,
      accentHex: nextAccent,
      customImageUrl: nextImage || null,
      sliders: nextSliders,
      personalitySummary: summarizePersonality(nextSliders),
      updatedAt: ctx.nowIso(),
    };

    await ctx.store.write(identityKeyForUser(user.id), updated);
    await syncPersonaFiles(ctx, updated, user.id);
    ctx.json(res, 200, { ...updated, fingerprint: personaFingerprint(updated) });
  });

  // GET /api/agent/personality -- per-user read 5 slider values & persona summary
  app.get('/api/agent/personality', async (req, res) => {
    const user = ctx.requireUser(req);
    const identity = await getAgentIdentity(ctx, user.id);
    ctx.json(res, 200, {
      name: identity.name,
      sliders: identity.sliders,
      personalitySummary: identity.personalitySummary,
      accentHex: identity.accentHex,
      traits: identity.traits,
      updatedAt: identity.updatedAt,
      fingerprint: personaFingerprint(identity),
    });
  });

  // PUT /api/agent/personality -- per-user update; NO mutation of Jcode global memory
  app.put('/api/agent/personality', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    // support both {sliders:{}} and bare sliders object
    const sliderInput = body?.sliders || body || {};
    const candidate = { sliders: sliderInput, name: body?.name };
    const errors = validateIdentityPayload(candidate);
    if (errors.length) return ctx.error(res, 400, errors.join('; '));
    const current = await getAgentIdentity(ctx, user.id);
    const sliders = normalizeSliders(sliderInput);
    const personalitySummary = summarizePersonality(sliders);

    const updated = {
      ...current,
      ...(body?.name ? { name: String(body.name).trim().slice(0, MAX_NAME_LEN) || current.name } : {}),
      sliders,
      personalitySummary,
      updatedAt: ctx.nowIso(),
    };

    await ctx.store.write(identityKeyForUser(user.id), updated);
    await syncPersonaFiles(ctx, updated, user.id);

    // Intentionally NOT writing to ~/.jcode/memory/global.json to avoid corrupting
    // native Jcode memory graph. Native memory is read-only via adapter; Jcode itself
    // manages its own memory writes through its SDK.

    ctx.json(res, 200, { ...updated, fingerprint: personaFingerprint(updated) });
  });

  // GET /api/agent/memory -- READ ONLY, admin-gated
  app.get('/api/agent/memory', async (req, res) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;
    const graph = await loadAllMemoryGraphs(ctx);
    ctx.json(res, 200, { ...graph, readOnly: true, message: 'Jcode native memory is read-only via adapter' });
  });

  // POST /api/agent/memory -- 501 read-only
  app.post('/api/agent/memory', async (req, res) => {
    ctx.requireUser(req);
    return ctx.error(res, 501, 'Jcode memory is read-only via adapter (use Jcode SDK directly)');
  });

  // POST /api/agent/memory/:id/reinforce -- 501 read-only
  app.post('/api/agent/memory/:id/reinforce', async (req, res) => {
    ctx.requireUser(req);
    return ctx.error(res, 501, 'Jcode memory is read-only via adapter');
  });

  // DELETE /api/agent/memory/:id -- 501 read-only
  app.delete('/api/agent/memory/:id', async (req, res) => {
    ctx.requireUser(req);
    return ctx.error(res, 501, 'Jcode memory is read-only via adapter');
  });

  // GET /api/agent/workspace -- admin-gated, allowlisted, realpath-contained
  app.get('/api/agent/workspace', async (req, res) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;
    const url = new URL(req.url, 'http://localhost');
    const roots = getWorkspaceRoots(ctx);
    const rootId = url.searchParams.get('root') || 'jcode';
    const relPath = url.searchParams.get('path') || '';
    const activeRoot = roots.find((r) => r.id === rootId) || roots[0];

    try {
      await fs.mkdir(activeRoot.basePath, { recursive: true }).catch(() => {});
      const { resolvedTarget, cleanRel } = await resolveContainedWorkspacePath(
        activeRoot.basePath,
        relPath,
        { rootId: activeRoot.id, userId: user.id, forWrite: false },
      );
      const dirents = await fs.readdir(resolvedTarget, { withFileTypes: true });
      const entries = [];
      for (const d of dirents) {
        if (BLOCKED_WORKSPACE_NAMES.has(d.name)) continue;
        if (d.name.endsWith('.sock') || d.name.endsWith('.lock') || d.name.endsWith('.bak')) continue;
        const entryRelPosix = cleanRel ? path.posix.join(cleanRel.split(path.sep).join('/'), d.name) : d.name;
        if (!isAllowedWorkspaceRel(activeRoot.id, entryRelPosix)) continue;
        if (isBlockedWorkspacePath(entryRelPosix)) continue;
        const full = path.join(resolvedTarget, d.name);
        // realpath containment for child: skip symlink escaping
        let realFull = full;
        try {
          realFull = await fs.realpath(full);
          const realBase = await fs.realpath(activeRoot.basePath).catch(() => path.resolve(activeRoot.basePath));
          if (realFull !== realBase && !realFull.startsWith(`${realBase}${path.sep}`)) continue;
          const realRelChild = path.relative(realBase, realFull).split(path.sep).join('/');
          if (!isAllowedWorkspaceRel(activeRoot.id, realRelChild)) continue;
          if (isBlockedWorkspacePath(realRelChild)) continue;
        } catch {
          // if lstat fails to realpath, still check allowlist on logical name
        }
        let st = null;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        entries.push({
          name: d.name,
          path: entryRelPosix,
          kind: st.isDirectory() ? 'dir' : 'file',
          size: st.isDirectory() ? 0 : st.size,
          updatedAt: st.mtime.toISOString(),
          ext: d.isDirectory() ? '' : path.extname(d.name).toLowerCase(),
        });
      }
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      ctx.json(res, 200, {
        roots: roots.map(r => ({ ...r, allowlisted: true })),
        activeRoot: activeRoot.id,
        currentPath: cleanRel === '.' ? '' : cleanRel.split(path.sep).join('/'),
        entries,
        readOnly: activeRoot.id === 'jcode',
      });
    } catch (err) {
      const status = err && err.status ? err.status : 400;
      ctx.error(res, status, err && err.message ? err.message : 'failed to list workspace');
    }
  });

  // GET /api/agent/workspace/file -- admin-gated, allowlisted, realpath-contained
  app.get('/api/agent/workspace/file', async (req, res) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;
    const url = new URL(req.url, 'http://localhost');
    const roots = getWorkspaceRoots(ctx);
    const rootId = url.searchParams.get('root') || 'jcode';
    const relPath = url.searchParams.get('path') || '';
    const activeRoot = roots.find((r) => r.id === rootId) || roots[0];

    if (!relPath) {
      return ctx.json(res, 200, {
        root: activeRoot.id,
        path: '',
        absPath: activeRoot.basePath,
        name: '',
        size: 0,
        updatedAt: ctx.nowIso(),
        ext: '',
        language: 'text',
        writable: false,
        truncated: false,
        content: '',
        readOnly: true,
      });
    }

    try {
      const { resolvedTarget, cleanRel } = await resolveContainedWorkspacePath(
        activeRoot.basePath,
        relPath,
        { rootId: activeRoot.id, userId: user.id, forWrite: false },
      );
      const st = await fs.stat(resolvedTarget);
      if (st.isDirectory()) {
        return ctx.error(res, 400, 'path is a directory');
      }
      const MAX_BYTES = 256 * 1024;
      const fh = await fs.open(resolvedTarget, 'r');
      try {
        const len = Math.min(st.size, MAX_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
        const ext = path.extname(resolvedTarget).toLowerCase();
        const posixRel = cleanRel.split(path.sep).join('/');
        const writable = isWritableWorkspaceRel(activeRoot.id, posixRel, user.id);
        ctx.json(res, 200, {
          root: activeRoot.id,
          path: posixRel,
          absPath: resolvedTarget,
          name: path.basename(resolvedTarget),
          size: st.size,
          updatedAt: st.mtime.toISOString(),
          ext,
          language: detectLanguage(ext),
          writable,
          truncated: st.size > MAX_BYTES,
          content: buf.toString('utf8'),
          readOnly: !writable,
        });
      } finally {
        await fh.close();
      }
    } catch (err) {
      const status = err && err.status ? err.status : 404;
      ctx.error(res, status, err && err.message ? err.message : 'file not found');
    }
  });

  // PUT /api/agent/workspace/file -- admin-gated, strictly allowlisted writable paths only
  app.put('/api/agent/workspace/file', async (req, res) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;
    const body = await ctx.readJson(req);
    const roots = getWorkspaceRoots(ctx);
    const rootId = String(body?.root || 'amiro');
    const relPath = String(body?.path || '');
    const content = String(body?.content ?? '');
    if (content.length > 512 * 1024) {
      return ctx.error(res, 400, 'content too large (max 512KB)');
    }
    const activeRoot = roots.find((r) => r.id === rootId);
    if (!activeRoot || !relPath) {
      return ctx.error(res, 400, 'root and path are required');
    }

    try {
      const { resolvedTarget, cleanRel } = await resolveContainedWorkspacePath(
        activeRoot.basePath,
        relPath,
        { rootId: activeRoot.id, userId: user.id, forWrite: true },
      );
      await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
      await fs.writeFile(resolvedTarget, content, 'utf8');
      const st = await fs.stat(resolvedTarget);
      ctx.json(res, 200, { ok: true, updatedAt: st.mtime.toISOString() });
    } catch (err) {
      const status = err && err.status ? err.status : 400;
      ctx.error(res, status, err && err.message ? err.message : 'failed to write file');
    }
  });
}
