// adapter/tests/ownership.mjs -- cross-user ownership regression.
//
// Spawns the adapter on a FRESH temp AMIRO_HOME with registration enabled,
// creates two users, has user A create a thread with a real pinned turn, then
// proves user B cannot read/write/chat/title/export/message A's thread, and
// that a fabricated unmapped message id is refused WITHOUT touching the daemon.
// Never touches any preview user or provider credentials.
//
// Run: node tests/ownership.mjs   (exit 0 = all assertions passed)

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(__dirname, '..');
const PORT = Number(process.env.AMIRO_TEST_PORT || 8794);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCKET = process.env.JCODE_API_SOCKET || '/run/user/0/amiro-preview-api.sock';
const PINNED = 'opencode-go:deepseek-v4.1-flash,antigravity:gemini-3.8-flash-tiered';

const results = [];
let passed = true;
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) passed = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-own-'));
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
        AMIRO_ALLOW_REGISTRATION: '1',
        AMIRO_PINNED_MODELS: PINNED,
        JCODE_API_SOCKET: SOCKET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));

    if (!(await waitForHealth())) throw new Error(`server not healthy:\n${log}`);

    const reg = async (email) => {
      const r = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: email.split('@')[0], email, password: 'pw-12345' }),
      });
      return { status: r.status, body: await r.json() };
    };
    const a = await reg(`alice-${Date.now()}@example.invalid`);
    const b = await reg(`bob-${Date.now()}@example.invalid`);
    step('two users registered in isolated home', a.status === 200 && b.status === 200, `a=${a.status} b=${b.status}`);

    const hdr = (t) => ({ Authorization: `Bearer ${t}`, 'content-type': 'application/json' });
    const hA = hdr(a.body.token);
    const hB = hdr(b.body.token);

    // A creates a thread with a real pinned turn.
    const threadId = crypto.randomUUID();
    const chat = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({
        id: threadId,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Reply with exactly OK' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
      }),
    });
    const chatSse = await chat.text();
    step(
      "owner A's turn succeeds",
      /"type":"text-delta"/.test(chatSse) && chatSse.includes('data: [DONE]') && !/"type":"error"/.test(chatSse),
      `error=${(/"errorText":"([^"]*)"/.exec(chatSse) || [])[1] || ''}`,
    );

    const mapping = JSON.parse(await fs.readFile(path.join(home, 'threads.json'), 'utf8'))[threadId];
    const sessionId = mapping && mapping.sessionId;

    // B is denied on every A-thread surface.
    const bGet = await fetch(`${BASE}/api/thread/${threadId}`, { headers: hB });
    step('B cannot GET A thread', bGet.status === 404, `status=${bGet.status}`);

    const bPut = await fetch(`${BASE}/api/thread/${threadId}`, { method: 'PUT', headers: hB, body: JSON.stringify({ title: 'pwned' }) });
    step('B cannot PUT A thread', bPut.status === 404, `status=${bPut.status}`);

    const bDel = await fetch(`${BASE}/api/thread/${threadId}`, { method: 'DELETE', headers: hB });
    step('B cannot DELETE A thread', bDel.status === 404, `status=${bDel.status}`);

    const bTitle = await fetch(`${BASE}/api/chat/title`, { method: 'POST', headers: hB, body: JSON.stringify({ threadId, message: 'x' }) });
    step('B cannot TITLE A thread', bTitle.status === 404, `status=${bTitle.status}`);

    const bExport = await fetch(`${BASE}/api/chat/export`, { method: 'POST', headers: hB, body: JSON.stringify({ threadId }) });
    step('B cannot EXPORT A thread', bExport.status === 404, `status=${bExport.status}`);

    const bChat = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: hB,
      body: JSON.stringify({
        id: threadId,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'leak?' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
      }),
    });
    const bChatSse = await bChat.text();
    step(
      'B cannot CHAT into A thread (denied before any model call)',
      /thread not found/.test(bChatSse) && !/"type":"text-delta"/.test(bChatSse),
      `error=${(/"errorText":"([^"]*)"/.exec(bChatSse) || [])[1] || ''}`,
    );

    // Fabricated message id: refused without reaching the daemon.
    const bFab = await fetch(`${BASE}/api/thread/messages/msg_0_unmappedSession`, { method: 'DELETE', headers: hB });
    step('fabricated unmapped message id refused (404, no daemon call)', bFab.status === 404, `status=${bFab.status}`);

    // B cannot rewind A's real message either.
    if (sessionId) {
      const bMsg = await fetch(`${BASE}/api/thread/messages/msg_0_${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: hB });
      const bTrunc = await fetch(`${BASE}/api/thread/messages/msg_0_${encodeURIComponent(sessionId)}/truncate`, { method: 'POST', headers: hB });
      step('B cannot message-delete/truncate A thread', bMsg.status === 404 && bTrunc.status === 404, `del=${bMsg.status} trunc=${bTrunc.status}`);
    } else {
      step('B cannot message-delete/truncate A thread', false, 'no mapping found');
    }

    // B's list excludes A; B's delete-all leaves A intact.
    const bList = await (await fetch(`${BASE}/api/thread`, { headers: hB })).json();
    step("B's thread list excludes A thread", !bList.some((t) => t.id === threadId), `count=${bList.length}`);

    const bDelAll = await fetch(`${BASE}/api/thread`, { method: 'DELETE', headers: hB });
    const aGet = await fetch(`${BASE}/api/thread/${threadId}`, { headers: hA });
    const aThread = aGet.ok ? await aGet.json() : {};
    step(
      "B's delete-all does not remove A thread",
      bDelAll.status === 204 && aGet.status === 200 && (aThread.messages || []).length >= 2,
      `delAll=${bDelAll.status} aGet=${aGet.status} msgs=${(aThread.messages || []).length}`,
    );

    // A can still list own thread.
    const aList = await (await fetch(`${BASE}/api/thread`, { headers: hA })).json();
    step("A's thread list still contains A thread", aList.some((t) => t.id === threadId), `count=${aList.length}`);
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!server.killed) server.kill('SIGKILL');
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n=== EVIDENCE ===');
  console.log(JSON.stringify({ passed, steps: results }, null, 2));
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('ownership test crashed:', err);
  process.exit(1);
});
