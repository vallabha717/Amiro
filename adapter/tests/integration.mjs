// adapter/tests/integration.mjs -- end-to-end integration + safety evidence.
//
// Spawns the adapter against a FRESH temp AMIRO_HOME on loopback, then proves:
//   1. fresh home seeds a random admin password in a mode-0600 file
//   2. self-registration is refused (403) once users exist
//   3. a REAL streamed turn through the live bridge works, pinned to
//      opencode-go/deepseek-v4.1-flash (route-pinned; no fallback)
//   4. a model outside AMIRO_PINNED_MODELS is rejected (no fallback to another)
//   5. antigravity/gemini-3.8-flash-tiered route-pins (runtime model matches)
//   6. the safe tool profile strips shell/write tools for public sessions
//
// Run: node tests/integration.mjs
// Exit code 0 = all assertions passed.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { JcodeClient } from '@1jehuang/jcode-sdk';
import { applyToolProfile } from '../src/chat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(__dirname, '..');
const PORT = Number(process.env.AMIRO_TEST_PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;
// Dedicated preview bridge (loopback, --tool-profile none, same daemon).
const SOCKET = process.env.JCODE_API_SOCKET || '/run/user/0/amiro-preview-api.sock';
// Route pinning on this bridge uses the colon separator.
const PINNED = 'opencode-go:deepseek-v4.1-flash,antigravity:gemini-3.8-flash-tiered';

const evidence = { steps: [], passed: true };
function step(name, ok, detail) {
  evidence.steps.push({ name, ok, detail });
  if (!ok) evidence.passed = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-inttest-'));
  let server;
  try {
    server = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ADAPTER,
      env: {
        ...process.env,
        AMIRO_HOME: home,
        AMIRO_PORT: String(PORT),
        AMIRO_HOST: '127.0.0.1',
        AMIRO_TOKEN: '',
        AMIRO_PINNED_MODELS: PINNED,
        JCODE_API_SOCKET: SOCKET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));

    const healthy = await waitForHealth();
    step('server boots on loopback with fresh home', healthy, `home=${home}`);
    if (!healthy) throw new Error(`server did not become healthy:\n${serverLog}`);

    // 1. seeded admin password file, root-only
    const passwordPath = path.join(home, 'admin-initial-password');
    const raw = JSON.parse(await fs.readFile(passwordPath, 'utf8'));
    const mode = (await fs.stat(passwordPath)).mode & 0o777;
    step(
      'seeded admin random password in mode-0600 file',
      raw.email === 'admin@local' && raw.password && raw.password !== 'admin' && mode === 0o600,
      `email=${raw.email} mode=0${mode.toString(8)}`,
    );

    // 2. status + registration closed
    const status = await (await fetch(`${BASE}/api/auth/status`)).json();
    step(
      'auth status: seeded user, registration disabled, deployment safe',
      status.isFirstUser === false && status.registrationEnabled === false && status.deploymentSafe === true,
      JSON.stringify(status),
    );
    const regRes = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Intruder', email: `intruder-${Date.now()}@x`, password: 'hunter2' }),
    });
    step('public self-registration refused', regRes.status === 403, `status=${regRes.status}`);

    // 3. login as admin
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: raw.email, password: raw.password }),
    });
    const login = await loginRes.json();
    step('admin login succeeds', loginRes.ok && login.token, `user=${login.user && login.user.email}`);
    const auth = { Authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };

    // /api/chat/models is public and must expose route-qualified providers,
    // filtered to the pinned allow-list.
    const modelsRes = await fetch(`${BASE}/api/chat/models`);
    const models = await modelsRes.json();
    const flat = models.flatMap((p) => (p.models || []).map((m) => `${p.provider}:${m.name}`));
    step(
      '/api/chat/models exposes only pinned, provider-qualified models',
      modelsRes.ok && flat.includes('opencode-go:deepseek-v4.1-flash') && flat.includes('antigravity:gemini-3.8-flash-tiered') && flat.length === 2,
      JSON.stringify(flat),
    );

    const adminRes = await fetch(`${BASE}/api/ai/providers`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'noop', provider: 'noop', apiKey: '' }),
    });
    step('provider mutation allowed for admin', adminRes.status === 200, `status=${adminRes.status}`);

    // 4. First chat and title fired CONCURRENTLY (browser behaviour): the
    // adapter must serialize create_session and not attach the fresh session.
    const threadId = crypto.randomUUID();
    const chatReq = fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: threadId,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Reply with exactly OK' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
        // Attempt to widen tools through the payload -- must be ignored.
        mentions: [],
        allowedMcpServers: [],
        allowedAppDefaultToolkit: ['bash', 'write'],
      }),
    });
    // title request fired in parallel with the chat request above
    const titleReq = fetch(`${BASE}/api/chat/title`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        threadId,
        message: 'Concurrent title regression',
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      }),
    });
    const [chatRes, titleRes] = await Promise.all([chatReq, titleReq]);
    const [sse, titleSse] = await Promise.all([chatRes.text(), titleRes.text()]);
    const hasTextDelta = /"type":"text-delta"/.test(sse);
    const hasDone = sse.includes('data: [DONE]');
    const hasError = /"type":"error"/.test(sse);
    const pinnedInMeta = sse.includes('opencode-go:deepseek-v4.1-flash');
    const chatErr = (/"errorText":"([^"]*)"/.exec(sse) || [])[1] || '';
    const titleErr = (/"errorText":"([^"]*)"/.exec(titleSse) || [])[1] || '';
    step(
      'concurrent first chat + title both succeed (no unknown_session)',
      chatRes.ok &&
        !hasError &&
        titleRes.ok &&
        titleSse.includes('data: [DONE]') &&
        !/"type":"error"/.test(titleSse) &&
        !/unknown_session|Failed to restore/i.test(sse) &&
        !/unknown_session|Failed to restore/i.test(titleSse),
      `chatErr=${chatErr} titleErr=${titleErr}`,
    );
    step(
      'real streamed turn (pinned opencode-go/deepseek-v4.1-flash)',
      chatRes.ok && hasTextDelta && hasDone && !hasError && pinnedInMeta,
      `text-delta=${hasTextDelta} done=${hasDone} error=${hasError} pinnedMeta=${pinnedInMeta}`,
    );
    evidence.streamSnippet = sse.slice(0, 400);

    // 4b. Second turn on the SAME thread (existing session: attach required).
    // No tools -> every permission mode runs; omitted model -> first pinned.
    const defaultRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: threadId,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Reply with exactly OK again' }] },
        permissionMode: 'manual',
        // no chatModel: adapter must use the first pinned model
      }),
    });
    const defaultSse = await defaultRes.text();
    evidence.defaultStreamTail = defaultSse.slice(-500);
    const defaultErr = (/"errorText":"([^"]*)"/.exec(defaultSse) || [])[1] || '';
    step(
      'second turn on same thread succeeds with pinned default model',
      /"type":"text-delta"/.test(defaultSse) &&
        defaultSse.includes('data: [DONE]') &&
        !/"type":"error"/.test(defaultSse) &&
        defaultSse.includes('opencode-go:deepseek-v4.1-flash'),
      `err=${defaultErr} tail=${defaultSse.replace(/\s+/g, ' ').slice(-240)}`,
    );

    // 4c. Persisted history must be readable (this was the live bug: messages:[]).
    const threadRes = await fetch(`${BASE}/api/thread/${threadId}`, { headers: auth });
    const thread = await threadRes.json();
    const roles = (thread.messages || []).map((m) => m.role);
    step(
      'GET /api/thread/:id returns persisted messages',
      threadRes.ok && roles.length >= 4 && roles.includes('user') && roles.includes('assistant'),
      `count=${roles.length} roles=${JSON.stringify(roles)}`,
    );

    // 5. disallowed model rejected, no fallback
    const badRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: crypto.randomUUID(),
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        chatModel: { provider: 'opencode-go', model: 'claude-opus-5-5' },
        permissionMode: 'auto',
      }),
    });
    const badSse = await badRes.text();
    step(
      'model outside allow-list rejected (no fallback)',
      /model not allowed/.test(badSse),
      badSse.match(/model not allowed[^"]*/)?.[0] || badSse.slice(0, 160),
    );

    // 6. gemini route-pins via SDK (runtime model must match the request)
    const jc = await JcodeClient.connect({ socketPath: SOCKET, clientName: 'amiro-inttest/1' });
    try {
      const s = await jc.createSession({ workingDir: path.join(home, 'workspace') });
      await jc.setModel(s.session_id, 'antigravity:gemini-3.8-flash-tiered');
      const info = await jc.getRuntimeInfo(s.session_id);
      step(
        'antigravity:gemini-3.8-flash-tiered route-pins',
        info.model === 'gemini-3.8-flash-tiered' && /antigravity/i.test(info.provider || ''),
        `provider=${info.provider} model=${info.model}`,
      );
      // 7. explicit no-tools profile for the public preview (text only)
      const before = (await jc.listTools(s.session_id)).map((t) => t.name);
      const okProfile = await applyToolProfile(jc, s.session_id);
      const after = (await jc.listTools(s.session_id)).map((t) => t.name);
      step(
        'explicit public tool profile exposes no tools',
        okProfile === true && after.length === 0,
        `before=${before.length} after=${after.length}`,
      );
    } finally {
      await jc.close().catch(() => {});
    }

    evidence.serverLogTail = serverLog.split('\n').slice(-6).join('\n');
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!server.killed) server.kill('SIGKILL');
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(os.tmpdir(), 'amiro-probe-ws'), { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n=== EVIDENCE ===');
  console.log(JSON.stringify({ passed: evidence.passed, steps: evidence.steps }, null, 2));
  process.exit(evidence.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('integration test crashed:', err);
  process.exit(1);
});
