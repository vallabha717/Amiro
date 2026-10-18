// adapter/src/routes/credentials.mjs -- credential store routes (Node mirror).
//
// Mirrors backend/src/routes/credentials.rs. Credentials are instance-wide:
// writes are admin-only, while any authenticated user may list metadata
// (service/field/label/hint plus the Vellum-style policy: exported env var,
// usage description, allowed tools and domains). No route ever returns a value.
//
//   GET    /api/credentials                 -> { items: CredentialMetadata[] }
//   PUT    /api/credentials                 -> metadata for the saved credential
//   DELETE /api/credentials/:service/:field -> { success: true }
//   POST   /api/credentials/validate        -> { valid: boolean }
//   POST   /api/credentials/broker          -> { ok, status, body } with the
//                                              secret injected server-side and
//                                              scrubbed from the response.
//
// The on-disk store is shared with the Rust backend (`$AMIRO_HOME/protected`).

import { createCredentials } from '../credentials.mjs';

const DEFAULT_COMPOSIO_BASE_URL = 'https://backend.composio.dev';
const VALIDATE_TIMEOUT_MS = 15_000;
const REDACTED = '[REDACTED]';

const DEFAULT_HEADER = 'Authorization';
const DEFAULT_PREFIX = 'Bearer ';

function requireAdmin(req, res, ctx) {
  const user = ctx.requireUser(req);
  if (user.role !== 'admin') {
    ctx.error(res, 403, 'Forbidden');
    return null;
  }
  return user;
}

// Collect a JSON array of non-empty, trimmed strings, ignoring other types.
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Whether a host matches one allow-list pattern. `*.example.com` matches
// `example.com` and any subdomain; anything else is an exact match.
export function hostMatchesDomain(host, pattern) {
  const bare = String(host ?? '').trim().replace(/\.+$/, '').toLowerCase();
  const rule = String(pattern ?? '').trim().replace(/\.+$/, '').toLowerCase();
  if (!bare || !rule) return false;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(2);
    return bare === suffix || bare.endsWith(`.${suffix}`);
  }
  return bare === rule;
}

// Enforce a credential's allowedDomains. Empty means "no restriction".
export function hostAllowed(host, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.some((pattern) => hostMatchesDomain(host, pattern));
}

// Replace every occurrence of a secret in a text blob with [REDACTED].
export function scrubSecret(text, secret) {
  if (!secret) return String(text ?? '');
  return String(text ?? '').split(String(secret)).join(REDACTED);
}

function composioBaseUrl() {
  const override = (process.env.AMIRO_COMPOSIO_BASE_URL || '').trim().replace(/\/+$/, '');
  return override || DEFAULT_COMPOSIO_BASE_URL;
}

function githubBaseUrl() {
  return (process.env.AMIRO_GITHUB_BASE_URL || '').trim().replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function register(app, ctx) {
  const creds = createCredentials({
    home: ctx.config?.home || ctx.store.home,
    store: ctx.store,
    log: ctx.log,
  });

  // GET /api/credentials
  app.get('/api/credentials', async (req, res) => {
    ctx.requireUser(req);
    const items = await creds.listMetadata();
    ctx.json(res, 200, { items });
  });

  // PUT /api/credentials
  app.put('/api/credentials', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    const body = await ctx.readJson(req);
    const service = typeof body.service === 'string' ? body.service : '';
    const field = typeof body.field === 'string' ? body.field : '';
    const value = typeof body.value === 'string' ? body.value : '';
    const label = typeof body.label === 'string' ? body.label : undefined;

    // Policy fields are optional. When a key is absent, preserve whatever is
    // already stored for the slot so a value-only re-save cannot drop policy.
    let existing = null;
    try {
      existing = (await creds.listMetadata()).find(
        (item) => item.service === service && item.field === field,
      );
    } catch {
      existing = null;
    }
    const description =
      typeof body.usageDescription === 'string'
        ? body.usageDescription
        : existing?.usageDescription ?? undefined;
    const tools = Object.prototype.hasOwnProperty.call(body, 'allowedTools')
      ? stringArray(body.allowedTools)
      : existing?.allowedTools ?? [];
    const domains = Object.prototype.hasOwnProperty.call(body, 'allowedDomains')
      ? stringArray(body.allowedDomains)
      : existing?.allowedDomains ?? [];

    try {
      const metadata = await creds.setWithPolicy(
        service,
        field,
        value,
        label,
        description,
        tools,
        domains,
      );
      ctx.json(res, 200, metadata);
    } catch (err) {
      ctx.error(res, 400, err && err.message ? err.message : 'invalid credential');
    }
  });

  // DELETE /api/credentials/:service/:field
  app.delete('/api/credentials/:service/:field', async (req, res, params) => {
    if (!requireAdmin(req, res, ctx)) return;
    await creds.delete(params.service, params.field);
    ctx.json(res, 200, { success: true });
  });

  // POST /api/credentials/validate
  app.post('/api/credentials/validate', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    const body = await ctx.readJson(req);
    const service = typeof body.service === 'string' ? body.service : '';
    const field = typeof body.field === 'string' ? body.field : '';

    if (service !== 'composio' && service !== 'github') {
      ctx.error(res, 400, 'validation is only supported for service "composio"');
      return;
    }
    if (service === 'github' && !githubBaseUrl()) {
      ctx.error(
        res,
        400,
        'validation is only supported for service "composio" (github needs AMIRO_GITHUB_BASE_URL)',
      );
      return;
    }

    const secret = await creds.getPlaintext(service, field);
    if (!secret) {
      ctx.error(res, 404, 'credential is not configured');
      return;
    }

    try {
      let response;
      if (service === 'composio') {
        response = await fetchWithTimeout(`${composioBaseUrl()}/api/v3/toolkits?limit=1`, {
          headers: { 'x-api-key': secret },
        });
      } else {
        response = await fetchWithTimeout(`${githubBaseUrl()}/user`, {
          headers: {
            authorization: `token ${secret}`,
            'user-agent': 'amiro',
            accept: 'application/vnd.github+json',
          },
        });
      }
      ctx.json(res, 200, { valid: response.ok });
    } catch {
      ctx.error(res, 502, 'could not reach the upstream provider');
    }
  });

  // POST /api/credentials/broker
  app.post('/api/credentials/broker', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    const body = await ctx.readJson(req);
    const service = typeof body.service === 'string' ? body.service : '';
    const field = typeof body.field === 'string' ? body.field : '';
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (!rawUrl) {
      ctx.error(res, 400, 'url is required');
      return;
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      ctx.error(res, 400, 'url must be an absolute http(s) URL');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.error(res, 400, 'url must be an absolute http(s) URL');
      return;
    }

    let metadata;
    try {
      metadata = (await creds.listMetadata()).find(
        (item) => item.service === service && item.field === field,
      );
    } catch {
      metadata = null;
    }
    if (!metadata) {
      ctx.error(res, 404, 'credential is not configured');
      return;
    }
    if (!hostAllowed(parsed.hostname, metadata.allowedDomains)) {
      ctx.error(res, 403, `host ${parsed.hostname} is not allowed for this credential`);
      return;
    }

    const secret = await creds.getPlaintext(service, field);
    if (!secret) {
      ctx.error(res, 404, 'credential is not configured');
      return;
    }

    const method = (typeof body.method === 'string' && body.method.trim()
      ? body.method.trim()
      : 'GET').toUpperCase();
    const headerName =
      typeof body.headerName === 'string' && body.headerName.trim()
        ? body.headerName.trim()
        : DEFAULT_HEADER;
    const valuePrefix = typeof body.valuePrefix === 'string' ? body.valuePrefix : DEFAULT_PREFIX;

    const headers = {};
    let hasContentType = false;
    if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
      for (const [name, value] of Object.entries(body.headers)) {
        if (typeof value !== 'string') continue;
        if (name.toLowerCase() === 'content-type') hasContentType = true;
        headers[name] = value;
      }
    }
    headers[headerName] = `${valuePrefix}${secret}`;

    let payload;
    if (body.body !== undefined && body.body !== null) {
      if (typeof body.body === 'string') {
        payload = body.body;
      } else {
        payload = JSON.stringify(body.body);
        if (!hasContentType) headers['content-type'] = 'application/json';
      }
    }

    try {
      const response = await fetchWithTimeout(parsed.toString(), { method, headers, body: payload });
      const text = await response.text();
      ctx.json(res, 200, {
        ok: response.ok,
        status: response.status,
        body: scrubSecret(text, secret),
      });
    } catch (err) {
      ctx.error(res, 502, `brokered request failed: ${err && err.message ? err.message : err}`);
    }
  });
}
