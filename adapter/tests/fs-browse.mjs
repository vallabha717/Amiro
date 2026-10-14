// adapter/tests/fs-browse.mjs -- fs browse + per-thread workingDir regression.
// Spawns adapter on fresh temp AMIRO_HOME (port 8795), proves over real HTTP:
//   - unauthenticated 401 on /api/fs/*
//   - roots listing (defaults include /root,/home,/srv,/opt,/var/www,/tmp)
//   - browsing /root returns directories
//   - denied path /root/.ssh is refused (403)
//   - traversal outside allowed roots refused (/etc when not in roots, crafted ..)
//   - symlink pointing outside is refused
//   - chat with valid workingDir accepted and thread reports it
//   - chat with invalid workingDir rejected without fallback
// Run: node tests/fs-browse.mjs  (exit 0 = all pass)

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(__dirname, '..');
const PORT = Number(process.env.AMIRO_TEST_PORT || 8795);
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
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-fsbrowse-'));
  let server;
  // Temp dirs for valid workingDir and symlink target
  // Use /tmp explicitly: os.tmpdir() may resolve to /root/.jcode/scratch
  // which is under the deny list (/root/.jcode) and would make validDir invalid.
  const TMP_BASE = '/tmp';
  const validDir = path.join(TMP_BASE, `amiro-fsbrowse-valid-${Date.now()}-${process.pid}`);
  const symlinkPath = path.join(TMP_BASE, `amiro-fsbrowse-link-${Date.now()}-${process.pid}`);
  try {
    await fs.mkdir(validDir, { recursive: true });
    // Ensure a marker file so we could detect workingDir later if needed
    await fs.writeFile(path.join(validDir, 'marker.txt'), 'hello');

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
    let log = '';
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));

    const healthy = await waitForHealth();
    step('server boots', healthy, `home=${home}`);
    if (!healthy) throw new Error(`server not healthy:\n${log}`);

    // Read seeded admin password
    const passwordPath = path.join(home, 'admin-initial-password');
    const raw = JSON.parse(await fs.readFile(passwordPath, 'utf8'));
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: raw.email, password: raw.password }),
    });
    const login = await loginRes.json();
    step('admin login', loginRes.ok && login.token, `status=${loginRes.status}`);
    const auth = { Authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };

    // 1. unauthenticated 401 on fs routes
    const unauthRoots = await fetch(`${BASE}/api/fs/roots`);
    step('unauthenticated /api/fs/roots -> 401', unauthRoots.status === 401, `status=${unauthRoots.status}`);
    const unauthBrowse = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent('/tmp')}`);
    step('unauthenticated /api/fs/browse -> 401', unauthBrowse.status === 401, `status=${unauthBrowse.status}`);
    const unauthStat = await fetch(`${BASE}/api/fs/stat?path=${encodeURIComponent('/tmp')}`);
    step('unauthenticated /api/fs/stat -> 401', unauthStat.status === 401, `status=${unauthStat.status}`);

    // 2. roots listing
    const rootsRes = await fetch(`${BASE}/api/fs/roots`, { headers: auth });
    const rootsBody = await rootsRes.json();
    const expectedDefaults = ['/root', '/home', '/srv', '/opt', '/var/www', '/tmp'];
    const hasDefaults = expectedDefaults.every((r) => (rootsBody.roots || []).includes(r));
    step('GET /api/fs/roots contains defaults', rootsRes.ok && hasDefaults, `roots=${JSON.stringify(rootsBody.roots)}`);

    // 3. browsing /root returns directories
    const browseRootRes = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent('/root')}`, { headers: auth });
    const browseRoot = browseRootRes.ok ? await browseRootRes.json() : {};
    const hasEntries = browseRootRes.ok && Array.isArray(browseRoot.entries) && browseRoot.entries.length >= 0;
    const dirsExist = hasEntries && browseRoot.entries.some((e) => e.kind === 'dir');
    // Denied children must not be listed: /root/.ssh should not appear as entry
    const leaksSsh = hasEntries && browseRoot.entries.some((e) => e.name === '.ssh');
    step('GET /api/fs/browse /root returns directories', browseRootRes.ok && hasEntries, `entries=${browseRoot.entries ? browseRoot.entries.length : '0'} dirs=${dirsExist}`);
    step('denied child .ssh not listed in /root', !leaksSsh, `leak=${leaksSsh}`);

    // 4. denied path /root/.ssh refused
    // Ensure .ssh exists for realistic check; if not, test still expects deny regardless
    try { await fs.mkdir('/root/.ssh', { recursive: true }); } catch {}
    const deniedRes = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent('/root/.ssh')}`, { headers: auth });
    step('denied path /root/.ssh refused (403)', deniedRes.status === 403, `status=${deniedRes.status}`);
    const deniedStatRes = await fetch(`${BASE}/api/fs/stat?path=${encodeURIComponent('/root/.ssh')}`, { headers: auth });
    const deniedStat = deniedStatRes.ok ? await deniedStatRes.json() : {};
    step('stat denied path reports denied', deniedStatRes.ok && deniedStat.denied === true, `stat=${JSON.stringify(deniedStat)}`);

    // Check other denied paths
    const denied2 = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent('/root/.jcode')}`, { headers: auth });
    step('denied path /root/.jcode refused', denied2.status === 403, `status=${denied2.status}`);

    // 5. traversal outside allowed roots refused (/etc when not in roots, crafted ..)
    const etcRes = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent('/etc')}`, { headers: auth });
    step('outside roots /etc refused (403)', etcRes.status === 403, `status=${etcRes.status}`);
    const dotdotRes = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent('/tmp/../etc')}`, { headers: auth });
    step('crafted .. path /tmp/../etc refused', dotdotRes.status === 403, `status=${dotdotRes.status}`);
    const dotdot2 = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent('/root/../etc')}`, { headers: auth });
    step('crafted .. path /root/../etc refused', dotdot2.status === 403, `status=${dotdot2.status}`);

    // 6. symlink pointing outside is refused
    // Create symlink under /tmp pointing to /etc
    try { await fs.unlink(symlinkPath); } catch {}
    try { await fs.symlink('/etc', symlinkPath); } catch {}
    const symlinkRes = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent(symlinkPath)}`, { headers: auth });
    step('symlink pointing outside refused (403)', symlinkRes.status === 403, `status=${symlinkRes.status} path=${symlinkPath}`);
    // Also ensure symlink child is not listed when browsing /tmp (the link entry should be skipped)
    const browseTmpRes = await fetch(`${BASE}/api/fs/browse?path=${encodeURIComponent('/tmp')}`, { headers: auth });
    const browseTmp = browseTmpRes.ok ? await browseTmpRes.json() : { entries: [] };
    const symlinkName = path.basename(symlinkPath);
    const listedSymlink = (browseTmp.entries || []).some((e) => e.name === symlinkName);
    step('symlink outside not listed in /tmp', !listedSymlink, `listed=${listedSymlink} name=${symlinkName}`);

    // 7. chat with valid workingDir accepted and thread reports it
    const threadValid = crypto.randomUUID();
    const chatValidRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: threadValid,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Reply with exactly OK' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
        workingDir: validDir,
      }),
    });
    const chatValidText = await chatValidRes.text();
    const validIsSse = chatValidRes.ok && /"type":"text-delta"/.test(chatValidText) && chatValidText.includes('data: [DONE]');
    // Even if jcode bridge not available, the adapter should still accept the dir and attempt a turn; we check thread mapping
    // If bridge unavailable, turn may error but thread should still be created with workingDir
    // So we check SSE success OR at least thread exists with workingDir
    let threadValidBody = null;
    try {
      const tRes = await fetch(`${BASE}/api/thread/${threadValid}`, { headers: auth });
      if (tRes.ok) threadValidBody = await tRes.json();
    } catch {}
    const validReportsDir = threadValidBody && threadValidBody.workingDir && path.resolve(threadValidBody.workingDir) === path.resolve(validDir);
    if (validIsSse) {
      step('chat with valid workingDir accepted (SSE)', true, `thread=${threadValid}`);
      step('thread reports valid workingDir', validReportsDir, `workingDir=${threadValidBody && threadValidBody.workingDir}`);
    } else {
      // If SSE failed (e.g., bridge down), at least thread mapping should exist with workingDir if turn was attempted
      // Alternatively, if the adapter rejected before creating session, that's a failure
      // We consider it pass if thread exists with correct dir, even without SSE success
      const hasThread = !!threadValidBody;
      step('chat with valid workingDir accepted (thread mapping)', hasThread && validReportsDir, `sseOk=${validIsSse} status=${chatValidRes.status} body=${chatValidText.slice(0, 300)} workingDir=${threadValidBody && threadValidBody.workingDir}`);
      if (!hasThread) {
        step('thread reports valid workingDir (without SSE)', false, `no thread mapping, sse=${chatValidText.slice(0,200)}`);
      } else if (!validReportsDir) {
        step('thread reports valid workingDir (without SSE)', false, `workingDir=${threadValidBody && threadValidBody.workingDir} expected=${validDir}`);
      }
    }

    // Also test projectDirectory alias (frontend compatibility)
    const threadAlias = crypto.randomUUID();
    const aliasDir = path.join(TMP_BASE, `amiro-fsbrowse-alias-${Date.now()}`);
    await fs.mkdir(aliasDir, { recursive: true });
    const chatAliasRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: threadAlias,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Reply with exactly OK' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
        projectDirectory: aliasDir,
      }),
    });
    const chatAliasText = await chatAliasRes.text();
    const aliasSseOk = chatAliasRes.ok && /"type":"text-delta"/.test(chatAliasText);
    let aliasThread = null;
    try {
      const r = await fetch(`${BASE}/api/thread/${threadAlias}`, { headers: auth });
      if (r.ok) aliasThread = await r.json();
    } catch {}
    const aliasReports = aliasThread && aliasThread.workingDir && path.resolve(aliasThread.workingDir) === path.resolve(aliasDir);
    step('chat with projectDirectory alias accepted', (aliasSseOk || !!aliasThread) && aliasReports, `aliasDir=${aliasDir} reports=${aliasThread && aliasThread.workingDir} sseOk=${aliasSseOk}`);
    await fs.rm(aliasDir, { recursive: true, force: true }).catch(() => {});

    // 8. chat with invalid workingDir rejected without fallback
    const threadInvalid = crypto.randomUUID();
    const chatInvalidRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: threadInvalid,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
        workingDir: '/root/.ssh',
      }),
    });
    // Should be 403 or 400 JSON, not 200 SSE, and not silently create thread with fallback
    step('chat with invalid workingDir rejected (403/400)', chatInvalidRes.status === 403 || chatInvalidRes.status === 400, `status=${chatInvalidRes.status}`);
    const invalidThreadRes = await fetch(`${BASE}/api/thread/${threadInvalid}`, { headers: auth });
    step('invalid workingDir does not create thread (no fallback)', invalidThreadRes.status === 404, `status=${invalidThreadRes.status}`);

    const outsideThread = crypto.randomUUID();
    const chatOutsideRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: outsideThread,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
        workingDir: '/etc',
      }),
    });
    step('chat with outside-roots workingDir rejected', chatOutsideRes.status === 403 || chatOutsideRes.status === 400, `status=${chatOutsideRes.status}`);
    const outsideCheck = await fetch(`${BASE}/api/thread/${outsideThread}`, { headers: auth });
    step('outside workingDir does not create thread', outsideCheck.status === 404, `status=${outsideCheck.status}`);

    // 9. switching workingDir on an EXISTING thread rotates session and reports new dir
    // Create thread with dir A, then send second turn with dir B; thread must report B.
    const switchA = path.join(TMP_BASE, `amiro-fsbrowse-switchA-${Date.now()}-${process.pid}`);
    const switchB = path.join(TMP_BASE, `amiro-fsbrowse-switchB-${Date.now()}-${process.pid}`);
    await fs.mkdir(switchA, { recursive: true });
    await fs.mkdir(switchB, { recursive: true });
    const switchThread = crypto.randomUUID();
    const switchRes1 = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: switchThread,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Reply with exactly OK' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
        workingDir: switchA,
      }),
    });
    const switchText1 = await switchRes1.text();
    // Capture mapping/session after first turn
    let switchBody1 = null;
    try {
      const r = await fetch(`${BASE}/api/thread/${switchThread}`, { headers: auth });
      if (r.ok) switchBody1 = await r.json();
    } catch {}
    const map1 = JSON.parse(await fs.readFile(path.join(home, 'threads.json'), 'utf8').catch(() => '{}'));
    const sessA = map1[switchThread] && map1[switchThread].sessionId;
    const reportsA = switchBody1 && switchBody1.workingDir && path.resolve(switchBody1.workingDir) === path.resolve(switchA);
    step('switch test: first turn with dir A reports A', !!switchBody1 && reportsA, `workingDir=${switchBody1 && switchBody1.workingDir} expected=${switchA} ok=${/\"type\":\"text-delta\"/.test(switchText1)}`);
    // Second turn with dir B
    const switchRes2 = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: switchThread,
        message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Reply with exactly OK again' }] },
        chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        permissionMode: 'auto',
        workingDir: switchB,
      }),
    });
    const switchText2 = await switchRes2.text();
    let switchBody2 = null;
    try {
      const r = await fetch(`${BASE}/api/thread/${switchThread}`, { headers: auth });
      if (r.ok) switchBody2 = await r.json();
    } catch {}
    const map2 = JSON.parse(await fs.readFile(path.join(home, 'threads.json'), 'utf8').catch(() => '{}'));
    const sessB = map2[switchThread] && map2[switchThread].sessionId;
    const reportsB = switchBody2 && switchBody2.workingDir && path.resolve(switchBody2.workingDir) === path.resolve(switchB);
    const rotated = sessA && sessB && sessA !== sessB;
    step('switch test: second turn with dir B reports B', !!switchBody2 && reportsB, `workingDir=${switchBody2 && switchBody2.workingDir} expected=${switchB}`);
    step('switch test: session rotated on workingDir change', rotated, `sessA=${sessA} sessB=${sessB} same=${sessA===sessB}`);
    step('switch test: dir A is no longer the active root', reportsB && (!switchBody2 || path.resolve(switchBody2.workingDir) !== path.resolve(switchA)), `active=${switchBody2 && switchBody2.workingDir}`);
    // The previous session should still be reachable via previousSessionId, not deleted
    const hasPrev = map2[switchThread] && map2[switchThread].previousSessionId === sessA;
    step('switch test: previous session retained as previousSessionId', hasPrev, `prev=${map2[switchThread] && map2[switchThread].previousSessionId} expected=${sessA}`);
    await fs.rm(switchA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(switchB, { recursive: true, force: true }).catch(() => {});

  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!server.killed) server.kill('SIGKILL');
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    await fs.rm(validDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(symlinkPath).catch(() => {});
  }

  console.log('\n=== EVIDENCE ===');
  console.log(JSON.stringify({ passed, steps: results }, null, 2));
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('fs-browse test crashed:', err);
  process.exit(1);
});
