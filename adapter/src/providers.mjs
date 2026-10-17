// adapter/src/providers.mjs -- full provider catalog with real auth mechanisms.
//
// Merges `amiro provider list --json` (the SKU catalog) with
// `amiro auth status --json` (connection state), normalizes auth_kind into a
// machine `mechanism`, and exposes a cached `providerCatalog(ctx)`.
//
// Cache: 60s, fixed argv, no shell injection (execFile with argv array).
// Credential sources are redacted: never return key material.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRuntimeCliEnv, resolveRuntimeBin } from './runtime.mjs';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 60_000;

const NORMALIZE = {
  'oauth': 'oauth',
  'api key': 'api-key',
  'device code': 'device-code',
  'cli': 'cli',
  'api key / cli': 'api-key',
  'local endpoint': 'local-endpoint',
};

function normalizeMechanism(authKind, providerId) {
  // `auto` is a routing pseudo-provider, not a credential mechanism.
  if (providerId === 'auto') return 'automatic';
  if (!authKind) return 'unknown';
  const key = String(authKind).trim().toLowerCase();
  if (NORMALIZE[key]) return NORMALIZE[key];
  if (key.includes('oauth')) return 'oauth';
  if (key.includes('device')) return 'device-code';
  if (key.includes('local')) return 'local-endpoint';
  if (key.includes('api key')) return 'api-key';
  if (key === 'cli') return 'cli';
  return 'unknown';
}

function redactCredentialSource(value) {
  if (!value) return value;
  // Replace anything that looks like a key/token value.
  // Patterns: sk-..., long base64-ish strings, env var assignments with values
  let s = String(value);
  // Redact env assignments like KEY=actual_value
  s = s.replace(/([A-Za-z0-9_]+)=([^\s),;]+)/g, (m, k, v) => {
    // Keep the key name, redact the value if it looks secret-ish (length > 8 or starts with sk-)
    if (v.length > 8 || /^sk-/.test(v) || /^[A-Za-z0-9_-]{16,}$/.test(v)) {
      return `${k}=[REDACTED]`;
    }
    return m;
  });
  // Redact standalone sk- tokens
  s = s.replace(/sk-[A-Za-z0-9_.-]{6,}/g, 'sk-[REDACTED]');
  s = s.replace(/sk-or-[A-Za-z0-9_.-]{6,}/g, 'sk-or-[REDACTED]');
  return s;
}

function redactHealth(value) {
  // Health strings contain source info that may include key previews; keep structure but redact
  return redactCredentialSource(value);
}

let cache = { at: 0, data: null };

async function execJson(bin, args, env) {
  const { stdout } = await execFileAsync(bin, args, {
    env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  const text = String(stdout).trim();
  if (!text) return {};
  return JSON.parse(text);
}

// Build the catalog. ctx carries the runtime home/binary via ctx.config +
// ctx.runtime.
export async function providerCatalog(ctx, { force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;

  const bin = resolveRuntimeBin(ctx.config.runtimeBin);
  const env = buildRuntimeCliEnv(ctx.config);

  // Run both commands with fixed argv — no shell, no injection.
  const [providerListRaw, authStatusRaw] = await Promise.all([
    execJson(bin, ['provider', 'list', '--json'], env).catch((err) => {
      ctx.log('warn', 'amiro runtime provider list failed', { error: String(err && err.message) });
      return { providers: [] };
    }),
    // Use ctx.runtime.authStatus when available (already cached), but we need fresh for the combined catalog.
    execJson(bin, ['auth', 'status', '--json'], env).catch((err) => {
      ctx.log('warn', 'amiro runtime auth status failed', { error: String(err && err.message) });
      return { providers: [] };
    }),
  ]);

  const listProviders = Array.isArray(providerListRaw.providers) ? providerListRaw.providers : [];
  const authProviders = Array.isArray(authStatusRaw.providers) ? authStatusRaw.providers : [];

  // Index auth status by id for O(1) join.
  const byId = new Map();
  for (const p of authProviders) {
    if (p && p.id) byId.set(String(p.id).toLowerCase(), p);
  }
  // Also index by alias-ish lowercased id for provider list entries that may differ.
  // provider list ids already match auth ids for overlap; auth has superset (53 vs 28).

  // Union: start from authProviders (superset, ~53), then add any provider-list-only entries.
  const seen = new Set();
  const out = [];

  function pushFromAuth(auth) {
    const id = String(auth.id);
    const lower = id.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    const displayName = auth.display_name || auth.displayName || id;
    const authKind = auth.auth_kind || auth.authKind || null;
    const mechanism = normalizeMechanism(authKind, id);
    const connected = String(auth.status || '').toLowerCase() === 'available';
    const credentialSource = redactCredentialSource(auth.credential_source || auth.credentialSource || null);
    const health = redactHealth(auth.health || null);
    const canStartOauth = mechanism === 'oauth' || mechanism === 'device-code';
    const canAcceptApiKey = mechanism === 'api-key';
    // For "API key / CLI" we normalized to api-key, which is correct for key storage.
    // local-endpoint and cli cannot accept API keys via the key endpoint.
    out.push({
      id,
      displayName,
      authKind,
      mechanism,
      connected,
      status: auth.status || 'not_configured',
      method: auth.method || null,
      credentialSource,
      health,
      expiryConfidence: auth.expiry_confidence || auth.expiryConfidence || null,
      refreshSupport: auth.refresh_support || auth.refreshSupport || null,
      validationMethod: auth.validation_method || auth.validationMethod || null,
      lastRefresh: auth.last_refresh ?? auth.lastRefresh ?? null,
      validation: auth.validation || null,
      recommended: Boolean(auth.recommended),
      detail: null,
      aliases: [],
      canStartOauth,
      canAcceptApiKey,
    });
  }

  function pushFromList(entry) {
    const id = String(entry.id);
    const lower = id.toLowerCase();
    if (seen.has(lower)) {
      // Merge detail/aliases/display into existing auth entry.
      const existing = out.find((o) => o.id.toLowerCase() === lower);
      if (existing) {
        if (entry.detail && !existing.detail) existing.detail = entry.detail;
        if (Array.isArray(entry.aliases) && entry.aliases.length) {
          const merged = new Set([...(existing.aliases || []), ...entry.aliases]);
          existing.aliases = [...merged];
        }
        // Prefer provider-list display_name if auth one is bare id
        if (entry.display_name && existing.displayName === existing.id) {
          existing.displayName = entry.display_name;
        }
      }
      return;
    }
    seen.add(lower);
    const authKind = entry.auth_kind ?? entry.authKind ?? null;
    const mechanism = normalizeMechanism(authKind, id);
    const canStartOauth = mechanism === 'oauth' || mechanism === 'device-code';
    const canAcceptApiKey = mechanism === 'api-key';
    out.push({
      id,
      displayName: entry.display_name || entry.displayName || id,
      authKind,
      mechanism,
      connected: false,
      status: 'not_configured',
      method: null,
      credentialSource: null,
      health: null,
      expiryConfidence: null,
      refreshSupport: null,
      validationMethod: null,
      lastRefresh: null,
      validation: null,
      recommended: Boolean(entry.recommended),
      detail: entry.detail || null,
      aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
      canStartOauth,
      canAcceptApiKey,
    });
  }

  for (const a of authProviders) pushFromAuth(a);
  for (const e of listProviders) pushFromList(e);

  // Deterministic sort: recommended first, then connected, then alpha by displayName.
  out.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return String(a.displayName).localeCompare(String(b.displayName));
  });

  const result = { providers: out, generatedAt: new Date().toISOString() };
  cache = { at: now, data: result };
  return result;
}

export function invalidateCatalog() {
  cache = { at: 0, data: null };
}

export function _normalizeMechanismForTest(v) {
  return normalizeMechanism(v);
}

export function _redactForTest(v) {
  return redactCredentialSource(v);
}
