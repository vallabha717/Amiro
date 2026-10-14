// adapter/src/routes/providers-catalog.mjs -- full provider catalog + API-key management.
//
// GET  /api/providers/catalog               -> providerCatalog(ctx) (auth required)
// POST /api/providers/:id/api-key           -> store API key via CLI, admin-only
// DELETE /api/providers/:id/credentials     -> remove stored key, admin-only
//
// API-key storage mechanism (verified in isolated JCODE_HOME):
//   jcode login <provider> --no-validate  with the raw key on STDIN
//     -> writes $JCODE_HOME/config/jcode/<provider>.env  (OPENROUTER_API_KEY=...)
//   For openai-compatible: jcode login openai-compatible --api-base <url> --api-key <key> --no-validate
//   Deletion: unlink the env file + (best-effort) jcode SDK clearApiKey + notifyAuthChanged.
//
// After storing or deleting we run `jcode auth status --json` to confirm the flip
// and call `notifyAuthChanged` so the live daemon picks up the new file without restart.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { providerCatalog, invalidateCatalog } from '../providers.mjs';

const CLI_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1024 * 1024;

function requireAdmin(req, res, ctx) {
  const user = ctx.requireUser(req);
  if (user.role !== 'admin') {
    ctx.error(res, 403, 'admin required');
    return null;
  }
  return user;
}

function sanitizeError(msg) {
  if (!msg) return 'Authentication error';
  return String(msg)
    .replace(/(?:code|state|token|access_token|refresh_token|client_secret|api[_-]?key)=[^&\s]+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_.-]{3,}/g, 'sk-[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL]')
    .trim() || 'Authentication error';
}

function resolveJcodeHome(ctx) {
  return ctx.config.jcodeHome || process.env.JCODE_HOME || path.join(os.homedir(), '.jcode');
}

function envFilePath(ctx, providerId) {
  // Mirrors jcode's file layout: $JCODE_HOME/config/jcode/<provider>.env
  // XDG_CONFIG_HOME is ignored by jcode when JCODE_HOME is set (verified).
  return path.join(resolveJcodeHome(ctx), 'config', 'jcode', `${providerId}.env`);
}

// Run jcode CLI with fixed argv (no shell), pipe stdin, cap buffers, timeout.
function runCli(bin, args, stdin, env, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = spawn(bin, args, { env, stdio: [stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ code: -1, stdout, stderr: 'Command timed out' });
    }, timeoutMs);

    proc.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    proc.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    if (stdin !== null) {
      try { proc.stdin.write(stdin); proc.stdin.end(); } catch {}
    }

    const settle = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) resolve({ code: -1, stdout, stderr: err.message });
      else resolve({ code: code ?? 0, stdout, stderr });
    };
    proc.on('close', (c) => settle(null, c));
    proc.on('error', (err) => settle(err, null));
  });
}

async function notifyAuthChanged(ctx, providerId) {
  // Best-effort: SDK path first (daemon hot-reload), then CLI fallback.
  try {
    if (ctx.jcode && ctx.jcode.api && typeof ctx.jcode.api.notifyAuthChanged === 'function') {
      await ctx.jcode.api.notifyAuthChanged(providerId);
    }
  } catch (err) {
    ctx.log('warn', 'notifyAuthChanged SDK failed', { provider: providerId, error: String(err && err.message) });
  }
  try {
    await ctx.jcode.authStatus({ force: true });
  } catch (err) {
    ctx.log('warn', 'authStatus refresh failed', { provider: providerId, error: String(err && err.message) });
  }
  invalidateCatalog();
}

export function register(app, ctx) {
  // GET /api/providers/catalog
  app.get('/api/providers/catalog', async (req, res) => {
    ctx.requireUser(req);
    try {
      const catalog = await providerCatalog(ctx);
      ctx.json(res, 200, catalog);
    } catch (err) {
      ctx.log('warn', 'provider catalog failed', { error: String(err && err.message) });
      ctx.error(res, 500, 'failed to build provider catalog');
    }
  });

  // POST /api/providers/:id/api-key
  // Body: { apiKey: string, apiBase?: string }  (apiBase only for openai-compatible)
  app.post('/api/providers/:id/api-key', async (req, res, params) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;

    const providerId = String(params.id || '').trim().toLowerCase();
    if (!providerId) return ctx.error(res, 400, 'provider id required');

    let body;
    try {
      body = await ctx.readJson(req);
    } catch {
      return ctx.error(res, 400, 'invalid JSON body');
    }
    const rawKey = String(body.apiKey || body.key || '').trim();
    const apiBase = String(body.apiBase || body.baseUrl || body.base_url || '').trim() || null;

    if (!rawKey) return ctx.error(res, 400, 'apiKey is required');
    if (rawKey.length < 4) return ctx.error(res, 400, 'apiKey too short');
    if (rawKey.length > 4096) return ctx.error(res, 400, 'apiKey too long');

    // Resolve provider to check mechanism. Force refresh to ensure we do not
    // mistakenly allow an OAuth provider.
    let catalog;
    try {
      catalog = await providerCatalog(ctx);
    } catch {
      catalog = { providers: [] };
    }
    const provider = catalog.providers.find((p) => String(p.id).toLowerCase() === providerId);
    if (provider) {
      if (provider.mechanism === 'oauth' || provider.mechanism === 'device-code') {
        return ctx.error(res, 400, 'use the OAuth flow');
      }
      if (provider.mechanism === 'cli' || provider.mechanism === 'local-endpoint') {
        return ctx.error(res, 400, `provider '${providerId}' does not support API-key storage`);
      }
      // 'api-key' and 'unknown' are allowed; unknown may be a future provider that still takes a key.
      if (provider.mechanism !== 'api-key' && provider.mechanism !== 'unknown') {
        return ctx.error(res, 400, `provider '${providerId}' does not support API-key storage`);
      }
    } else {
      // Unknown provider id — still try? Reject to avoid writing stray files.
      return ctx.error(res, 404, `unknown provider '${providerId}'`);
    }

    const bin = ctx.config.jcodeBin || 'jcode';
    const env = { ...process.env, JCODE_NO_TELEMETRY: '1' };
    if (ctx.config.jcodeHome) env.JCODE_HOME = ctx.config.jcodeHome;

    let cliResult;
    if (providerId === 'openai-compatible') {
      if (!apiBase) {
        return ctx.error(res, 400, 'apiBase is required for openai-compatible');
      }
      // Non-interactive path requires both flags; never echoes key.
      cliResult = await runCli(bin, ['login', providerId, '--api-base', apiBase, '--api-key', rawKey, '--no-validate'], null, env);
    } else {
      // For normal API-key providers, pipe key on stdin (verified mechanism).
      // Use --no-validate to avoid live network calls during storage.
      cliResult = await runCli(bin, ['login', providerId, '--no-validate'], `${rawKey}\n`, env);
    }

    if (cliResult.code !== 0) {
      const msg = sanitizeError(cliResult.stderr || cliResult.stdout || 'Failed to store API key');
      ctx.log('warn', 'jcode login store key failed', { provider: providerId, error: msg });
      // Never include key material in error.
      return ctx.error(res, 400, msg);
    }

    // Confirm flip via auth status.
    await notifyAuthChanged(ctx, providerId);

    // Re-check status to include in response (redacted).
    let statusEntry = null;
    try {
      const status = await ctx.jcode.authStatus({ force: true });
      const list = Array.isArray(status.providers) ? status.providers : [];
      statusEntry = list.find((p) => String(p.id).toLowerCase() === providerId) || null;
    } catch {
      // ignore
    }
    const available = statusEntry ? String(statusEntry.status).toLowerCase() === 'available' : true;

    ctx.json(res, 200, { ok: true, provider: providerId, available });
  });

  // DELETE /api/providers/:id/credentials
  app.delete('/api/providers/:id/credentials', async (req, res, params) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;

    const providerId = String(params.id || '').trim().toLowerCase();
    if (!providerId) return ctx.error(res, 400, 'provider id required');

    // Verify provider exists.
    let catalog;
    try {
      catalog = await providerCatalog(ctx);
    } catch {
      catalog = { providers: [] };
    }
    const provider = catalog.providers.find((p) => String(p.id).toLowerCase() === providerId);
    if (!provider) return ctx.error(res, 404, `unknown provider '${providerId}'`);

    // Best-effort SDK clear.
    try {
      if (ctx.jcode && ctx.jcode.api && typeof ctx.jcode.api.clearApiKey === 'function') {
        await ctx.jcode.api.clearApiKey(providerId);
      }
    } catch (err) {
      ctx.log('warn', 'clearApiKey SDK failed', { provider: providerId, error: String(err && err.message) });
    }

    // Remove the env file (primary storage).
    const file = envFilePath(ctx, providerId);
    try {
      await fs.unlink(file);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        ctx.log('warn', 'failed to remove credential file', { provider: providerId, file, error: String(err.message) });
      }
    }
    // Also remove .bak if present (jcode rotates it).
    try {
      await fs.unlink(`${file}.bak`);
    } catch {
      // ignore
    }

    await notifyAuthChanged(ctx, providerId);

    ctx.json(res, 200, { ok: true, provider: providerId });
  });
}
