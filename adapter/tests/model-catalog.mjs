// adapter/tests/model-catalog.mjs -- regression test for dynamic model catalog.
//
// Spawns the adapter against a fresh temp AMIRO_HOME with AMIRO_PINNED_MODELS unset,
// asserting:
//   1. /api/chat/models is accessible without authentication (public route)
//   2. /api/chat/models contains groups for every provider that `amiro auth status --json` reports available
//   3. Each group's models match `amiro model list -p <id> --json`
//   4. Entries are namespaced provider:model
//   5. isModelAllowed agrees with the catalog (all catalog models allowed, fake models rejected)

import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isModelAllowed, allowedModelRefs } from '../src/models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(__dirname, '..');
const PORT = Number(process.env.AMIRO_TEST_PORT || 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCKET = process.env.AMIRO_API_SOCKET || process.env.JCODE_API_SOCKET || '/run/user/0/amiro-preview-api.sock';
// The Amiro runtime CLI (bin/amiro), which delegates to the runtime engine.
// AMIRO_RUNTIME_BIN overrides it; the pre-rename variables stay supported.
const RUNTIME_BIN =
  process.env.AMIRO_RUNTIME_BIN ||
  process.env.AMIRO_JCODE_BIN ||
  process.env.JCODE_BIN ||
  path.resolve(__dirname, '..', '..', 'bin', 'amiro');

const evidence = { steps: [], passed: true };
function step(name, ok, detail) {
  evidence.steps.push({ name, ok, detail });
  if (!ok) evidence.passed = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (detail: ${detail})` : ''}`);
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-cat-test-'));
  let server;

  // Run authoritative CLI checks directly to compare with adapter
  const authStdout = execFileSync(RUNTIME_BIN, ['auth', 'status', '--json'], { encoding: 'utf8' });
  const authData = JSON.parse(authStdout || '{}');
  const availableProviders = (authData.providers || []).filter((p) => p && p.status === 'available');

  const expectedByProvider = {};
  for (const p of availableProviders) {
    try {
      const modelStdout = execFileSync(RUNTIME_BIN, ['model', 'list', '-p', p.id, '--json'], {
        encoding: 'utf8',
      });
      const res = JSON.parse(modelStdout || '{}');
      expectedByProvider[p.id] = {
        name: p.display_name || res.provider || p.id,
        models: Array.isArray(res.models) ? res.models : [],
      };
    } catch (err) {
      console.warn(`Warning: failed to fetch models for provider ${p.id}:`, err.message);
    }
  }

  const spawnedEnv = { ...process.env };
  delete spawnedEnv.AMIRO_PINNED_MODELS;
  spawnedEnv.AMIRO_HOME = home;
  spawnedEnv.AMIRO_PORT = String(PORT);
  spawnedEnv.AMIRO_HOST = '127.0.0.1';
  spawnedEnv.AMIRO_TOKEN = '';
  spawnedEnv.AMIRO_API_SOCKET = SOCKET;

  try {
    server = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ADAPTER,
      env: spawnedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let serverLog = '';
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));

    const healthy = await waitForHealth();
    step('server boots on loopback with fresh home', healthy, `port=${PORT} home=${home}`);
    if (!healthy) throw new Error(`server did not become healthy:\n${serverLog}`);

    // 1. Unauthenticated public access to /api/chat/models
    const modelsRes = await fetch(`${BASE}/api/chat/models`);
    step(
      'unauthenticated access to /api/chat/models succeeds',
      modelsRes.status === 200,
      `status=${modelsRes.status}`,
    );

    const catalog = await modelsRes.json();
    step(
      '/api/chat/models returns an array',
      Array.isArray(catalog),
      `length=${Array.isArray(catalog) ? catalog.length : typeof catalog}`,
    );

    // 2. Contains groups for every provider reported available by `amiro auth status`
    const returnedProviderIds = catalog.map((g) => g.provider);
    const expectedProviderIds = Object.keys(expectedByProvider);
    const hasAllProviders = expectedProviderIds.every((id) => returnedProviderIds.includes(id));
    step(
      'catalog contains groups for every available provider',
      hasAllProviders && catalog.length === expectedProviderIds.length,
      `expected=${expectedProviderIds.join(', ')} got=${returnedProviderIds.join(', ')}`,
    );

    // 3. Each group's models match `amiro model list -p <id> --json`
    let allModelsMatch = true;
    const mismatches = [];
    for (const group of catalog) {
      const exp = expectedByProvider[group.provider];
      if (!exp) {
        allModelsMatch = false;
        mismatches.push(`unexpected provider ${group.provider}`);
        continue;
      }
      const actualModelNames = (group.models || []).map((m) => m.name);
      const expModelNames = exp.models;
      const countMatch = actualModelNames.length === expModelNames.length;
      const contentMatch = expModelNames.every((m, idx) => actualModelNames[idx] === m);
      if (!countMatch || !contentMatch) {
        allModelsMatch = false;
        mismatches.push(
          `${group.provider}: expected ${expModelNames.length} models, got ${actualModelNames.length}`,
        );
      }
    }
    step(
      'each group models match amiro model list per provider',
      allModelsMatch,
      mismatches.length ? mismatches.join('; ') : `verified ${catalog.length} providers`,
    );

    // 4. Entries are namespaced provider:model
    const namespaced = catalog.flatMap((g) =>
      (g.models || []).map((m) => `${g.provider}:${m.name}`),
    );
    const allNamespaced =
      namespaced.length > 0 &&
      namespaced.every((ref) => {
        const parts = ref.split(':');
        return parts.length >= 2 && Boolean(parts[0]) && Boolean(parts[1]);
      });
    step(
      'entries are namespaced provider:model',
      allNamespaced,
      `totalNamespaced=${namespaced.length}`,
    );

    // 5. isModelAllowed agrees with the catalog
    const allowedRefs = allowedModelRefs({});
    let allowedAgrees = true;
    let allowedDiscrepancies = [];

    for (const group of catalog) {
      for (const m of group.models || []) {
        const ref = `${group.provider}:${m.name}`;
        if (!isModelAllowed({}, group.provider, m.name)) {
          allowedAgrees = false;
          allowedDiscrepancies.push(`false negative for ${ref}`);
        }
        if (!allowedRefs.has(ref)) {
          allowedAgrees = false;
          allowedDiscrepancies.push(`missing in allowedModelRefs: ${ref}`);
        }
      }
    }

    const fakeRejected1 = isModelAllowed({}, 'openai', 'this-model-definitely-does-not-exist');
    const fakeRejected2 = isModelAllowed({}, 'nonexistent-provider', 'fake-model');
    const fakeRejected3 = isModelAllowed({}, '', 'invalid');
    const fakesProperlyRejected = !fakeRejected1 && !fakeRejected2 && !fakeRejected3;

    step(
      'isModelAllowed agrees with the dynamic catalog',
      allowedAgrees && fakesProperlyRejected,
      `checked=${namespaced.length} catalog models, fake rejection=${fakesProperlyRejected}`,
    );
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!server.killed) server.kill('SIGKILL');
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n=== EVIDENCE ===');
  console.log(JSON.stringify({ passed: evidence.passed, steps: evidence.steps }, null, 2));
  process.exit(evidence.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('model-catalog test crashed:', err);
  process.exit(1);
});
