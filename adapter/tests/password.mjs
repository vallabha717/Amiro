// adapter/tests/password.mjs -- password-change regression on an isolated home.
//
// Proves that a password change made through the supported API actually takes
// effect for subsequent logins and is NOT reverted by a later login's
// lastLogin write-back. Never touches the preview home or its credentials.
//
// Run: node tests/password.mjs   (exit 0 = all assertions passed)

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(__dirname, '..');
const PORT = Number(process.env.AMIRO_TEST_PORT || 8793);
const BASE = `http://127.0.0.1:${PORT}`;

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-pw-'));
  let server;
  try {
    server = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ADAPTER,
      env: { ...process.env, AMIRO_HOME: home, AMIRO_PORT: String(PORT), AMIRO_HOST: '127.0.0.1', AMIRO_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));
    if (!(await waitForHealth())) throw new Error(`server not healthy:\n${log}`);

    const seeded = JSON.parse(await fs.readFile(path.join(home, 'admin-initial-password'), 'utf8'));
    const login = (password, email = seeded.email) =>
      fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    const NEW = 'Vallabha717@';

    const first = await login(seeded.password);
    step('seeded password logs in', first.status === 200, `status=${first.status}`);
    const { token } = await first.json();
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const missing = await fetch(`${BASE}/api/user/password`, { method: 'PUT', headers: auth, body: JSON.stringify({ currentPassword: seeded.password }) });
    step('missing newPassword rejected', missing.status === 400, `status=${missing.status}`);

    const wrongCurrent = await fetch(`${BASE}/api/user/password`, { method: 'PUT', headers: auth, body: JSON.stringify({ currentPassword: 'not-the-password', newPassword: NEW }) });
    step('wrong current password rejected', wrongCurrent.status === 400, `status=${wrongCurrent.status}`);
    step('failed change leaves old password working', (await login(seeded.password)).status === 200);

    const change = await fetch(`${BASE}/api/user/password`, { method: 'PUT', headers: auth, body: JSON.stringify({ currentPassword: seeded.password, newPassword: NEW }) });
    step('password change accepted', change.status === 200, `status=${change.status}`);

    step('new password logs in immediately', (await login(NEW)).status === 200);
    step('old password rejected immediately', (await login(seeded.password)).status === 401);

    // The regression that mattered: another login must not revert the file.
    const again = await login(NEW);
    step('new password still works after another login', again.status === 200, `status=${again.status}`);
    step('old password still rejected after another login', (await login(seeded.password)).status === 401);

    const stored = JSON.parse(await fs.readFile(path.join(home, 'users.json'), 'utf8')).users[0];
    const rowMatches = typeof stored.passwordHash === 'string' && stored.passwordHash.length > 0;
    const oldHashStillOnDisk = await (async () => {
      const { scryptSync } = await import('node:crypto');
      const [salt, expected] = stored.passwordHash.split(':');
      return scryptSync(seeded.password, salt, 64).toString('hex') === expected;
    })();
    step('on-disk hash updated and not reverted', rowMatches && !oldHashStillOnDisk, `updatedAt=${stored.updatedAt || 'missing'}`);
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
  console.error('password test crashed:', err);
  process.exit(1);
});
