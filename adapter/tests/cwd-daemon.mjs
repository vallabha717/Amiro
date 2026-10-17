// adapter/tests/cwd-daemon.mjs -- does the picked folder reach the daemon?
//
// The adapter stores the chosen folder on its own thread mapping, but the user's
// requirement is that the session actually works in that folder. This test asks
// the Amiro runtime directly (SDK getRuntimeInfo) instead of trusting the map.
//
// Spawns the adapter on a fresh temp AMIRO_HOME (port 8796) against the real
// bridge, creates a thread in an allowed directory, then:
//   - reads the session id from the temp home's threads.json
//   - attaches over the SDK and asserts the daemon reports that directory
//   - changes the folder on the same thread and asserts a new session is used
//     and the daemon reports the new directory
// Never touches the preview home, its users or its provider credentials.
//
// Run: node tests/cwd-daemon.mjs   (exit 0 = all assertions passed)

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { JcodeClient as AmiroRuntimeClient } from '@1jehuang/jcode-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(__dirname, '..');
const PORT = Number(process.env.AMIRO_TEST_PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCKET = process.env.AMIRO_API_SOCKET || process.env.JCODE_API_SOCKET || '/run/user/0/amiro-preview-api.sock';
const MODEL = 'opencode-go:deepseek-v4.1-flash';

const results = [];
let passed = true;
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) passed = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function waitForHealth(timeoutMs = 20000) {
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

function daemonDir(runtime) {
  if (!runtime) return null;
  for (const key of ['working_dir', 'workingDir', 'working_directory', 'cwd', 'workdir']) {
    if (typeof runtime[key] === 'string' && runtime[key]) return runtime[key].replace(/\/$/, '');
  }
  return null;
}

// The daemon records the directory each session runs in; getRuntimeInfo does not
// expose it, so read it from listSessions().
async function daemonSessionDir(client, sessionId) {
  const list = await client.listSessions();
  const arr = Array.isArray(list) ? list : (list && (list.sessions || [])) || [];
  const mine = arr.find((s) => s && (s.session_id === sessionId || s.id === sessionId));
  return daemonDir(mine);
}

async function readMapping(home, threadId) {
  const doc = JSON.parse(await fs.readFile(path.join(home, 'threads.json'), 'utf8'));
  return doc[threadId] || null;
}

async function turn(auth, threadId, workingDir, word) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: threadId,
      workingDir,
      permissionMode: 'interactive',
      chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      message: {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: `Reply with exactly ${word}. Do not use tools.` }],
      },
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-cwd-'));
  // /tmp is inside the default browse roots; os.tmpdir() may resolve under the
  // engine's real state directory (/root/.jcode), which the folder API denies.
  const dirA = `/tmp/amiro-cwd-a-${Date.now()}-${process.pid}`;
  const dirB = `/tmp/amiro-cwd-b-${Date.now()}-${process.pid}`;
  let server;
  let client;
  try {
    await fs.mkdir(path.join(dirA, 'innerA'), { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    server = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ADAPTER,
      env: {
        ...process.env,
        AMIRO_HOME: home,
        AMIRO_PORT: String(PORT),
        AMIRO_HOST: '127.0.0.1',
        AMIRO_TOKEN: '',
        AMIRO_PINNED_MODELS: MODEL,
        AMIRO_API_SOCKET: SOCKET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));
    if (!(await waitForHealth())) throw new Error(`server not healthy:\n${log}`);

    const seeded = JSON.parse(await fs.readFile(path.join(home, 'admin-initial-password'), 'utf8'));
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(seeded),
    });
    const { token } = await login.json();
    const auth = { Authorization: `Bearer ${token}` };

    const threadId = crypto.randomUUID();
    const first = await turn(auth, threadId, dirA, 'CWD_A_OK');
    step('turn in the picked folder is accepted', first.status === 200, `status=${first.status}`);

    const mappingA = await readMapping(home, threadId);
    step('thread mapping stores the picked folder', mappingA?.workingDir === dirA, `stored=${mappingA?.workingDir}`);

    client = await AmiroRuntimeClient.connect({ socketPath: SOCKET, clientName: 'amiro-cwd-test/1' });
    const reportedA = await daemonSessionDir(client, mappingA.sessionId);
    step(
      'daemon session really runs in the picked folder',
      reportedA === dirA,
      `daemon=${reportedA} expected=${dirA}`,
    );

    const thread = await (await fetch(`${BASE}/api/thread/${threadId}`, { headers: auth })).json();
    step('thread API reports the picked folder', thread.workingDir === dirA, `workingDir=${thread.workingDir}`);

    // Switching folders on the same thread must actually move the session.
    const second = await turn(auth, threadId, dirB, 'CWD_B_OK');
    step('turn after switching folder is accepted', second.status === 200, `status=${second.status}`);
    const mappingB = await readMapping(home, threadId);
    step('folder switch keeps the thread and rotates the session', mappingB?.sessionId && mappingB.sessionId !== mappingA.sessionId, `sessionA=${mappingA.sessionId} sessionB=${mappingB?.sessionId}`);
    step('previous session is retained for history', mappingB?.previousSessionId === mappingA.sessionId, `previous=${mappingB?.previousSessionId}`);

    const reportedB = await daemonSessionDir(client, mappingB.sessionId);
    step('daemon session runs in the new folder after the switch', reportedB === dirB, `daemon=${reportedB} expected=${dirB}`);

    const threadB = await (await fetch(`${BASE}/api/thread/${threadId}`, { headers: auth })).json();
    step('thread API reports the new folder', threadB.workingDir === dirB, `workingDir=${threadB.workingDir}`);

    const denied = await turn(auth, crypto.randomUUID(), '/root/.ssh', 'NOPE');
    step('denied folder is refused for a new thread', denied.status === 403, `status=${denied.status}`);
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!server.killed) server.kill('SIGKILL');
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dirA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dirB, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n=== EVIDENCE ===');
  console.log(JSON.stringify({ passed, steps: results }, null, 2));
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('cwd-daemon test crashed:', err);
  process.exit(1);
});
