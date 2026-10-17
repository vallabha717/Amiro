// adapter/test/workspace-listing.test.mjs -- regression tests for the Amiro
// workspace file browser (GET /api/agent/workspace and .../file).
//
// Three things this locks down, all discovered from a real review screenshot
// where the runtime tree rendered almost empty:
//   1. Directory nodes (memory, skills, users/<id>) must be listable. Allowing
//      only their children hid the directories themselves.
//   2. The allowlist must stay narrow: engine-internal files, credential files
//      and symlinks that escape an allowed directory stay unreadable and
//      unlisted.
//   3. config.toml is readable but its credential *values* are redacted, and the
//      response says so instead of returning them silently.
//
// Fully hermetic: no server, no runtime socket, no engine. The route handlers
// are driven directly through a fake app/ctx against a temp runtime home.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as agentRoutes from '../src/routes/agent.mjs';

const ADMIN = { id: 'admin', role: 'admin' };
const SECRET = 'sk-live-SECRETVALUE0123456789';

let root;
let runtimeHome;
let workspaceDir;
let app;
// Routes close over the ctx handed to register(), so json/error write here.
let response;

// Collects handlers the way server.mjs' router does, so the real register() runs.
function makeApp() {
  const routes = new Map();
  const add = (method) => (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  return { routes, get: add('GET'), put: add('PUT'), post: add('POST'), delete: add('DELETE') };
}

function makeCtx(config) {
  return {
    config,
    store: { readJson: async () => ({}), write: async () => {} },
    log: () => {},
    nowIso: () => new Date().toISOString(),
    requireUser: (req) => req.user,
    json: (_res, status, body) => {
      response = { status, body };
    },
    error: (_res, status, message) => {
      response = { status, body: { error: String(message) } };
    },
    readJson: async () => ({}),
  };
}

// Drive one registered handler with a fake request/response.
async function call(_t, method, url, user = ADMIN) {
  const { pathname } = new URL(url, 'http://localhost');
  const handler = app.routes.get(`${method} ${pathname}`);
  assert.ok(handler, `${method} ${pathname} must be registered`);
  response = undefined;
  const res = { writeHead() {}, end() {}, on() {} };
  const req = { method, url, headers: {}, user };
  await handler(req, res, app.ctx);
  assert.ok(response, `${method} ${pathname} must emit a response`);
  return response;
}

async function listing(t, rootId, relPath = '') {
  const q = new URLSearchParams({ root: rootId });
  if (relPath) q.set('path', relPath);
  const res = await call(t, 'GET', `/api/agent/workspace?${q}`);
  assert.equal(res.status, 200, `listing ${rootId}/${relPath} should succeed: ${JSON.stringify(res.body)}`);
  return res.body;
}

function names(body) {
  return body.entries.map((e) => e.name);
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-wslist-'));
  runtimeHome = path.join(root, 'runtime-home');
  workspaceDir = path.join(root, 'amiro-home', 'workspace');

  await fs.mkdir(path.join(runtimeHome, 'memory', 'projects'), { recursive: true });
  await fs.mkdir(path.join(runtimeHome, 'skills', 'skill-a'), { recursive: true });
  await fs.mkdir(path.join(runtimeHome, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, 'users', ADMIN.id), { recursive: true });

  await fs.writeFile(path.join(runtimeHome, 'memory', 'global.json'), '{"graph_version":2,"memories":[]}');
  await fs.writeFile(path.join(runtimeHome, 'memory', 'projects', 'p1.json'), '{"graph_version":2}');
  await fs.writeFile(path.join(runtimeHome, 'skills', 'skill-a', 'SKILL.md'), '# Skill A\n');
  await fs.writeFile(path.join(runtimeHome, 'prompt-overlay.md'), '# Overlay\n');
  await fs.writeFile(
    path.join(runtimeHome, 'config.toml'),
    [
      '[provider]',
      `api_key = "${SECRET}"`,
      'bing_api_key_env = "JCODE_BING_API_KEY"',
      'max_context_tokens = 0',
      'password = "hunter2"',
      'allow_api_keys = false',
      '',
    ].join('\n'),
  );
  // Files that must never appear in a listing, at any depth.
  await fs.writeFile(path.join(runtimeHome, 'auth.json'), '{"secret":"nope"}');
  await fs.writeFile(path.join(runtimeHome, 'antigravity_oauth.json'), '{"secret":"nope"}');
  await fs.writeFile(path.join(runtimeHome, 'certs.pem'), '-----BEGIN CERTIFICATE-----');
  await fs.writeFile(path.join(runtimeHome, 'engine.sock'), '');
  await fs.writeFile(path.join(runtimeHome, 'settings.json'), '{"not":"allowlisted"}');
  await fs.writeFile(path.join(workspaceDir, 'users', ADMIN.id, 'IDENTITY.md'), '# Identity\n');

  // A symlink inside an allowed directory pointing outside it.
  await fs.symlink('/etc', path.join(runtimeHome, 'memory', 'escape'), 'dir');

  app = makeApp();
  app.ctx = makeCtx({
    home: path.join(root, 'amiro-home'),
    workspaceDir,
    runtimeHome,
    outDir: workspaceDir,
  });
  agentRoutes.register(app, app.ctx);
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

test('runtime root lists the memory and skills directories, not just config.toml', async (t) => {
  const body = await listing(t, 'runtime');
  const found = names(body);
  assert.ok(found.includes('memory'), `memory must be listed, saw ${found.join(', ')}`);
  assert.ok(found.includes('skills'), `skills must be listed, saw ${found.join(', ')}`);
  assert.ok(found.includes('config.toml'), 'config.toml must be listed');
  assert.ok(found.includes('prompt-overlay.md'), 'prompt-overlay.md must be listed');
  assert.equal(body.activeRoot, 'runtime');
  assert.equal(body.readOnly, true);
  // Directories sort first, so the tree is browsable rather than a flat dump.
  assert.equal(body.entries[0].kind, 'dir');
});

test('runtime root never lists engine-internal or credential entries', async (t) => {
  const found = names(await listing(t, 'runtime'));
  for (const forbidden of [
    'auth.json',
    'antigravity_oauth.json',
    'certs.pem',
    'engine.sock',
    'settings.json',
    'sessions',
  ]) {
    assert.ok(!found.includes(forbidden), `${forbidden} must not be listed (saw ${found.join(', ')})`);
  }
});

test('memory is enterable and hides the symlink that escapes it', async (t) => {
  const body = await listing(t, 'runtime', 'memory');
  const found = names(body);
  assert.ok(found.includes('global.json'), `global.json must be listed, saw ${found.join(', ')}`);
  assert.ok(found.includes('projects'), `projects must be listed, saw ${found.join(', ')}`);
  assert.ok(!found.includes('escape'), 'a symlink pointing outside the root must not be listed');
  assert.equal(body.currentPath, 'memory');
});

test('memory/projects is enterable (nested directory nodes stay listable)', async (t) => {
  const body = await listing(t, 'runtime', 'memory/projects');
  assert.deepEqual(names(body), ['p1.json']);
});

test('skills is enterable and its skill directories are listable', async (t) => {
  const body = await listing(t, 'runtime', 'skills');
  assert.deepEqual(names(body), ['skill-a']);
  const nested = await listing(t, 'runtime', 'skills/skill-a');
  assert.deepEqual(names(nested), ['SKILL.md']);
});

test('workspace traversal and non-allowlisted engine files stay refused', async (t) => {
  const cases = [
    'memory/escape/passwd',
    'auth.json',
    'settings.json',
    '../../etc/passwd',
    'memory/../../etc/passwd',
  ];
  for (const rel of cases) {
    const res = await call(t, 'GET', `/api/agent/workspace/file?root=runtime&path=${encodeURIComponent(rel)}`);
    assert.equal(res.status, 403, `${rel} must be refused, got ${res.status}`);
  }
});

test('config.toml is readable with credential values redacted and honestly reported', async (t) => {
  const res = await call(t, 'GET', '/api/agent/workspace/file?root=runtime&path=config.toml');
  assert.equal(res.status, 200);
  const { content, redacted, redactionCount } = res.body;
  assert.ok(!content.includes(SECRET), 'the secret value must never be returned');
  assert.ok(!content.includes('hunter2'), 'a password value must never be returned');
  assert.ok(content.includes('"<redacted>"'), 'redaction marker must be present');
  // Key names, references and harmless numbers stay intact.
  assert.ok(content.includes('bing_api_key_env = "JCODE_BING_API_KEY"'), 'env-var references stay readable');
  assert.ok(content.includes('max_context_tokens = 0'), 'token counters stay readable');
  assert.ok(content.includes('allow_api_keys = false'), 'boolean flags stay readable');
  assert.equal(redacted, true);
  assert.ok(redactionCount >= 2, `expected at least 2 redactions, saw ${redactionCount}`);
  assert.ok(!JSON.stringify(res.body).includes(SECRET), 'no response field may carry the secret');
});

test('memory JSON files are returned unredacted (only config is a credential surface)', async (t) => {
  const res = await call(t, 'GET', '/api/agent/workspace/file?root=runtime&path=memory/global.json');
  assert.equal(res.status, 200);
  assert.equal(res.body.redacted, false);
  assert.match(res.body.content, /graph_version/);
});

test('amiro root exposes users/<id> directory nodes and their persona files', async (t) => {
  const top = await listing(t, 'amiro');
  assert.ok(names(top).includes('users'), `users must be listed, saw ${names(top).join(', ')}`);
  const perUser = await listing(t, 'amiro', 'users');
  assert.deepEqual(names(perUser), [ADMIN.id]);
  const idDir = await listing(t, 'amiro', `users/${ADMIN.id}`);
  assert.deepEqual(names(idDir), ['IDENTITY.md']);
  const file = await call(t, 'GET', `/api/agent/workspace/file?root=amiro&path=users/${ADMIN.id}/IDENTITY.md`);
  assert.equal(file.status, 200);
  assert.match(file.body.content, /Identity/);
});

test('amiro root still refuses files outside the persona mirror allowlist', async (t) => {
  await fs.writeFile(path.join(workspaceDir, 'users', ADMIN.id, 'secrets.json'), '{"x":1}');
  const res = await call(t, 'GET', `/api/agent/workspace/file?root=amiro&path=users/${ADMIN.id}/secrets.json`);
  assert.equal(res.status, 403);
});

test('unauthenticated and non-admin callers are refused', async (t) => {
  const anon = await call(t, 'GET', '/api/agent/workspace?root=runtime', null);
  assert.equal(anon.status, 403);
  const bob = await call(t, 'GET', '/api/agent/workspace?root=runtime', { id: 'bob', role: 'user' });
  assert.equal(bob.status, 403);
});

test('redactSensitiveConfig only touches credential values', () => {
  const { redactSensitiveConfig } = agentRoutes;
  const { text, redactions } = redactSensitiveConfig(
    'config.toml',
    ['api_key = "abc"', 'refresh_token = "def"', 'password_env = "PW"', 'key_name = "x"'].join('\n'),
  );
  assert.equal(redactions, 2);
  assert.match(text, /api_key = "<redacted>"/);
  assert.match(text, /refresh_token = "<redacted>"/);
  assert.match(text, /password_env = "PW"/);
  assert.match(text, /key_name = "x"/);
});

test('redactSensitiveConfig catches an inline credential under a harmless key', () => {
  const { redactSensitiveConfig } = agentRoutes;
  const { text, redactions } = redactSensitiveConfig('config.toml', 'model_label = "sk-abcdefghijklmnop1234"');
  assert.equal(redactions, 1);
  assert.equal(text, 'model_label = "<redacted>"');
});

test('redactSensitiveConfig leaves other files alone', () => {
  const { redactSensitiveConfig } = agentRoutes;
  const source = 'api_key = "abc"';
  assert.deepEqual(redactSensitiveConfig('notes.md', source), { text: source, redactions: 0 });
  assert.deepEqual(redactSensitiveConfig('config.toml', ''), { text: '', redactions: 0 });
});
