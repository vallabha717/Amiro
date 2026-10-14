// Enumerate changed adapter routes and observe each real public HTTP auth boundary.
// Only authenticated GETs are dispatched. Mutations without a bearer token must
// be rejected before handlers run. Positive CRUD/OAuth completion is NOT implied.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const base = process.env.AMIRO_TEST_URL || 'http://127.0.0.1:8788';
const publicRoutes = new Set(['GET /health', 'GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/register', 'GET /api/chat/models', 'GET /api/mcp/oauth/callback']);
const routes = new Map();
async function discover(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await discover(file);
    else if (entry.name.endsWith('.mjs')) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) {
        routes.set(`${match[1].toUpperCase()} ${match[2]}`, { method: match[1].toUpperCase(), route: match[2], file: path.relative(root, file) });
      }
    }
  }
}
await discover(root);
const creds = JSON.parse(await readFile(process.env.AMIRO_TEST_CREDENTIALS || '/root/.amiro-preview/admin-initial-password', 'utf8'));
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
assert.equal(login.status, 200);
const { token } = await login.json();
const rows = [];
try {
  for (const [key, item] of routes) {
    const url = item.route.replace(/:[A-Za-z][A-Za-z0-9_]*/g, 'audit-missing');
    if (publicRoutes.has(key) && item.method !== 'GET') {
      rows.push({ ...item, authCheck: 'covered by live-smoke', positiveCheck: 'login works; registration closed' });
      continue;
    }
    const response = await fetch(`${base}${url}`, { method: item.method, signal: AbortSignal.timeout(15000) });
    await response.arrayBuffer();
    const expected = publicRoutes.has(key) ? [200, 501] : item.route.startsWith('/storage/') ? [404] : [401];
    assert(expected.includes(response.status), `${key}: unauthenticated status ${response.status}, expected ${expected}`);
    const row = { ...item, unauthenticatedStatus: response.status, positiveCheck: 'NOT RUN: mutation requires isolated CRUD acceptance' };
    if (item.method === 'GET' && !publicRoutes.has(key)) {
      const authenticated = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
      await authenticated.arrayBuffer();
      assert(authenticated.status < 500 || authenticated.status === 501, `${key}: authenticated server failure ${authenticated.status}`);
      row.authenticatedStatus = authenticated.status;
      row.positiveCheck = item.route.includes(':') ? 'missing-resource read only, NOT success workflow' : 'real authenticated read, shape not fully asserted';
    }
    rows.push(row);
    console.log(`PASS ${key}: anonymous=${row.unauthenticatedStatus}${row.authenticatedStatus ? ` authenticated=${row.authenticatedStatus}` : ''}`);
  }
} finally {
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}
const artifactDir = process.env.JCODE_SCRATCH_DIR || '/root/.jcode/scratch';
await mkdir(artifactDir, { recursive: true });
await writeFile(path.join(artifactDir, 'amiro-route-acceptance.json'), JSON.stringify({ base, date: new Date().toISOString(), scope: 'Auth boundary for each literal registered route and authenticated read smoke only. Not full mutation acceptance.', routes: rows }, null, 2));
console.log(JSON.stringify({ routes: rows.length, artifact: `${artifactDir}/amiro-route-acceptance.json` }));
