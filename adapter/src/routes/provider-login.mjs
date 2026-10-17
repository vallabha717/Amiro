// adapter/src/routes/provider-login.mjs -- interactive OAuth provider login backend routes.
//
// Supports scriptable OAuth/device login flows using the Amiro runtime CLI:
//   - POST /api/providers/:id/oauth/start     -> allocates flow, prints auth URL / device code
//   - GET /api/providers/:id/oauth/status     -> checks current flow status (polling)
//   - POST /api/providers/:id/oauth/callback  -> submits authorization code or callback URL
//   - DELETE /api/providers/:id/oauth         -> cancels pending flow
//   - POST /api/providers/:id/oauth/cancel    -> cancels pending flow (POST alias)

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildRuntimeCliEnv, resolveRuntimeBin } from '../runtime.mjs';
import { providerCatalog } from '../providers.mjs';

// Fallback only: used when the live catalog cannot be read (engine CLI down).
// The live check below consults providerCatalog() so new engine OAuth
// providers work without editing this file.
const SUPPORTED_OAUTH_PROVIDERS = new Set([
  'claude',
  'openai',
  'gemini',
  'antigravity',
  'copilot',
  'google',
]);

// True when the provider's live catalog entry can start an OAuth/device flow.
// Unknown ids return false; when the catalog itself is unreadable we fall back
// to the static set above so a transient CLI failure cannot lock out logins.
async function canStartOauthFlow(ctx, provider) {
  try {
    const catalog = await providerCatalog(ctx);
    const entry = (catalog.providers || []).find(
      (p) => String(p.id || '').toLowerCase() === provider,
    );
    if (entry) return Boolean(entry.canStartOauth);
  } catch {
    // fall through to the static set
  }
  return SUPPORTED_OAUTH_PROVIDERS.has(provider);
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const CLI_TIMEOUT_MS = 30000;

function requireAdmin(req, res, ctx) {
  const user = ctx.requireUser(req);
  if (user.role !== 'admin') {
    ctx.error(res, 403, 'Forbidden');
    return null;
  }
  return user;
}

function sanitizeError(msg) {
  if (!msg) return 'Authentication error';
  return String(msg)
    .replace(/(?:code|state|token|access_token|refresh_token|client_secret)=[^&\s]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL]')
    .trim() || 'Authentication error';
}

function runCli(bin, args, input, env, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = spawn(bin, args, {
      env,
      stdio: [input !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve({ code: -1, stdout, stderr: 'Command timed out' });
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
    });

    if (input !== null) {
      try {
        proc.stdin.write(input);
        proc.stdin.end();
      } catch {
        // ignore stdin pipe errors
      }
    }

    const settle = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        resolve({ code: -1, stdout, stderr: err.message });
      } else {
        resolve({ code: code ?? 0, stdout, stderr });
      }
    };

    proc.on('close', (code) => settle(null, code));
    proc.on('error', (err) => settle(err, null));
  });
}

export function register(app, ctx) {
  // In-memory active flows map: key = `${userId}:${provider}`
  const activeFlows = new Map();

  function getActiveFlow(userId, provider) {
    const key = `${userId}:${provider}`;
    const flow = activeFlows.get(key);
    if (!flow) return null;
    if (Date.now() > flow.expiresAtMs && flow.status === 'pending') {
      flow.status = 'expired';
      if (flow.childProcess) {
        try {
          flow.childProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
        flow.childProcess = null;
      }
      cancelCliFlow(flow.provider, flow.flowId).catch(() => {});
    }
    return flow;
  }

  function clearActiveFlow(userId, provider) {
    const key = `${userId}:${provider}`;
    const flow = activeFlows.get(key);
    if (flow) {
      if (flow.childProcess) {
        try {
          flow.childProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      activeFlows.delete(key);
    }
    return flow;
  }

  async function cancelCliFlow(provider, flowId) {
    if (!flowId) return;
    const bin = resolveRuntimeBin(ctx.config.runtimeBin);
    const env = buildRuntimeCliEnv(ctx.config);

    await runCli(bin, ['login', provider, '--cancel', '--flow-id', flowId], null, env, 10000);
  }

  // POST /api/providers/:id/oauth/start -- initiate interactive OAuth or device flow
  app.post('/api/providers/:id/oauth/start', async (req, res, params) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;

    const provider = String(params.id || '').trim().toLowerCase();
    if (!(await canStartOauthFlow(ctx, provider))) {
      ctx.error(
        res,
        400,
        `Interactive OAuth is not supported for provider '${provider}'. Please configure with an API key.`
      );
      return;
    }

    // Cancel any prior flow for this user and provider
    const oldFlow = clearActiveFlow(user.id, provider);
    if (oldFlow) {
      await cancelCliFlow(provider, oldFlow.flowId);
    }

    const flowId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const bin = resolveRuntimeBin(ctx.config.runtimeBin);
    const env = buildRuntimeCliEnv(ctx.config);

    const { code, stdout, stderr } = await runCli(
      bin,
      ['login', provider, '--print-auth-url', '--json', '--flow-id', flowId],
      null,
      env
    );

    if (code !== 0) {
      const errMsg = sanitizeError(stderr || stdout || 'Failed to start login flow');
      ctx.log('warn', 'amiro runtime login --print-auth-url failed', { provider, error: errMsg });
      ctx.error(res, 400, errMsg);
      return;
    }

    let parsed = null;
    try {
      const text = stdout.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      ctx.error(res, 500, `Failed to parse login response: ${err.message}`);
      return;
    }

    if (!parsed || !parsed.auth_url) {
      ctx.error(res, 500, 'Invalid login response from CLI: missing auth_url');
      return;
    }

    const isDevice = provider === 'copilot' || Boolean(parsed.user_code);
    const expiresAtMs = parsed.expires_at_ms || Date.now() + 15 * 60 * 1000;
    const expiresIn = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));

    const flowRecord = {
      flowId,
      userId: user.id,
      provider,
      flow: isDevice ? 'device_code' : 'authorization_code',
      authorizationUrl: parsed.auth_url,
      userCode: parsed.user_code || undefined,
      verificationUri: isDevice ? parsed.auth_url : undefined,
      interval: isDevice ? 5 : undefined,
      expiresAtMs,
      status: 'pending',
      error: null,
      childProcess: null,
    };

    // For device code (copilot), start background polling with --complete
    if (isDevice) {
      const completeProc = spawn(
        bin,
        ['login', provider, '--complete', '--json', '--flow-id', flowId],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let cStdout = '';
      let cStderr = '';
      let completeSettled = false;

      completeProc.stdout.on('data', (d) => {
        if (cStdout.length < MAX_OUTPUT_BYTES) cStdout += d.toString();
      });
      completeProc.stderr.on('data', (d) => {
        if (cStderr.length < MAX_OUTPUT_BYTES) cStderr += d.toString();
      });

      const settleComplete = async (cCode) => {
        if (completeSettled) return;
        completeSettled = true;
        flowRecord.childProcess = null;
        if (cCode === 0) {
          flowRecord.status = 'authorized';
          flowRecord.error = null;
          try {
            await ctx.runtime.api.notifyAuthChanged(provider);
          } catch (err) {
            ctx.log('warn', 'notifyAuthChanged failed', { provider, error: String(err && err.message) });
          }
          try {
            await ctx.runtime.authStatus({ force: true });
          } catch (err) {
            ctx.log('warn', 'authStatus refresh failed', { provider, error: String(err && err.message) });
          }
        } else {
          flowRecord.status = 'error';
          flowRecord.error = sanitizeError(cStderr || cStdout || 'Device code completion failed');
        }
      };

      completeProc.on('close', (cCode) => settleComplete(cCode));
      completeProc.on('error', () => settleComplete(-1));

      flowRecord.childProcess = completeProc;
    }

    activeFlows.set(`${user.id}:${provider}`, flowRecord);

    ctx.json(res, 200, {
      flow: flowRecord.flow,
      authorizationUrl: flowRecord.authorizationUrl,
      userCode: flowRecord.userCode,
      verificationUri: flowRecord.verificationUri,
      interval: flowRecord.interval,
      expiresIn,
      flowId,
    });
  });

  // GET /api/providers/:id/oauth/status -- check current login flow status
  app.get('/api/providers/:id/oauth/status', async (req, res, params) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;

    const provider = String(params.id || '').trim().toLowerCase();
    const flow = getActiveFlow(user.id, provider);

    if (!flow) {
      ctx.error(res, 404, 'no active login flow');
      return;
    }

    ctx.json(res, 200, {
      status: flow.status,
      error: flow.error || undefined,
    });
  });

  // POST /api/providers/:id/oauth/callback -- submit code or callback URL
  app.post('/api/providers/:id/oauth/callback', async (req, res, params) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;

    const provider = String(params.id || '').trim().toLowerCase();
    const flow = getActiveFlow(user.id, provider);

    if (!flow) {
      ctx.error(res, 404, 'no active login flow');
      return;
    }
    if (flow.status !== 'pending') {
      ctx.error(res, 400, `login flow is not pending (current status: ${flow.status})`);
      return;
    }

    const body = await ctx.readJson(req);
    const rawInput = String(body.code || body.callbackUrl || body.url || '').trim();

    if (!rawInput) {
      ctx.error(res, 400, 'code or callbackUrl is required');
      return;
    }

    const isUrl = rawInput.startsWith('http://') || rawInput.startsWith('https://') || rawInput.includes('?');
    const bin = resolveRuntimeBin(ctx.config.runtimeBin);
    const env = buildRuntimeCliEnv(ctx.config);

    const flag = isUrl ? '--callback-url' : '--auth-code';
    const args = ['login', provider, '--flow-id', flow.flowId, flag, '-'];

    const { code, stdout, stderr } = await runCli(bin, args, `${rawInput}\n`, env);

    if (code === 0) {
      flow.status = 'authorized';
      flow.error = null;
      try {
        await ctx.runtime.api.notifyAuthChanged(provider);
      } catch (err) {
        ctx.log('warn', 'notifyAuthChanged failed', { provider, error: String(err && err.message) });
      }
      try {
        await ctx.runtime.authStatus({ force: true });
      } catch (err) {
        ctx.log('warn', 'authStatus refresh failed', { provider, error: String(err && err.message) });
      }
      ctx.json(res, 200, { status: 'authorized' });
    } else {
      const errMsg = sanitizeError(stderr || stdout || 'Token exchange failed');
      flow.status = 'error';
      flow.error = errMsg;
      ctx.json(res, 200, { status: 'error', error: errMsg });
    }
  });

  // DELETE /api/providers/:id/oauth -- cancel pending login flow
  app.delete('/api/providers/:id/oauth', async (req, res, params) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;

    const provider = String(params.id || '').trim().toLowerCase();
    const flow = clearActiveFlow(user.id, provider);
    if (flow) {
      await cancelCliFlow(provider, flow.flowId);
    }

    ctx.json(res, 200, { success: true });
  });

  // POST /api/providers/:id/oauth/cancel -- cancel alias
  app.post('/api/providers/:id/oauth/cancel', async (req, res, params) => {
    const user = requireAdmin(req, res, ctx);
    if (!user) return;

    const provider = String(params.id || '').trim().toLowerCase();
    const flow = clearActiveFlow(user.id, provider);
    if (flow) {
      await cancelCliFlow(provider, flow.flowId);
    }

    ctx.json(res, 200, { success: true });
  });
}
