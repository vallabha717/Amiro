// adapter/test/credentials.test.mjs -- credential store routes (Node mirror).
//
// Drives the real registered handlers through a fake app/ctx, plus a real local
// HTTP upstream for the broker, so injection, domain enforcement and secret
// scrubbing are exercised as served. The on-disk store is the shared encrypted
// store used by the Rust backend.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../src/store.mjs';
import { createCredentials, envVarName, sanitizeEnvPart } from '../src/credentials.mjs';
import { register, hostMatchesDomain, hostAllowed, scrubSecret } from '../src/routes/credentials.mjs';

const SECRET = 'sk-credential-secret-7788';
const ADMIN = { id: 'user-admin', role: 'admin' };
const USER = { id: 'user-1', role: 'user' };

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    raw: undefined,
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
    },
    end(body) {
      this.raw = body;
    },
  };
}

async function makeHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-credentials-test-'));
  const store = createStore(root);
  const routes = new Map();
  const app = {
    get(p, h) {
      routes.set(`GET ${p}`, h);
    },
    put(p, h) {
      routes.set(`PUT ${p}`, h);
    },
    post(p, h) {
      routes.set(`POST ${p}`, h);
    },
    delete(p, h) {
      routes.set(`DELETE ${p}`, h);
    },
  };
  const ctx = {
    config: { home: root },
    store,
    log: () => {},
    nowIso: () => new Date().toISOString(),
    readJson: async (req) => req._body || {},
    requireUser(req) {
      if (req.user) return req.user;
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    },
    json(res, status, obj) {
      res.writeHead(status);
      res.end(JSON.stringify(obj));
    },
    error(res, status, message) {
      res.writeHead(status);
      res.end(JSON.stringify({ error: String(message) }));
    },
  };
  register(app, ctx);

  async function call(method, routeTemplate, { body, user = ADMIN, params = {} } = {}) {
    const concrete = routeTemplate.replace(/:[^/]+/g, (m) => params[m.slice(1)]);
    let handler;
    for (const [key, value] of routes) {
      const [m, pattern] = key.split(' ');
      if (m !== method) continue;
      const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, '([^/]+)').replace(/\//g, '\\/')}$`);
      const match = concrete.match(regex);
      if (match) {
        handler = value;
        const names = [...pattern.matchAll(/:([^/]+)/g)].map((x) => x[1]);
        names.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        break;
      }
    }
    assert.ok(handler, `route ${method} ${routeTemplate} not registered`);
    const res = makeRes();
    await handler({ user, _body: body }, res, params);
    let parsed = null;
    if (typeof res.raw === 'string' && res.raw.length) parsed = JSON.parse(res.raw);
    return { status: res.statusCode, json: parsed, raw: res.raw };
  }

  return { root, store, call, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('env var names mirror the Rust sanitizer', () => {
  assert.equal(envVarName('github', 'token'), 'AMIRO_CRED_GITHUB_TOKEN');
  assert.equal(envVarName('tts.openai', 'api_key'), 'AMIRO_CRED_TTS_OPENAI_API_KEY');
  assert.equal(sanitizeEnvPart('api-key'), 'API_KEY');
});

test('domain patterns and scrubbing behave', () => {
  assert.ok(hostMatchesDomain('api.github.com', 'api.github.com'));
  assert.ok(hostMatchesDomain('sub.example.com', '*.example.com'));
  assert.ok(hostMatchesDomain('example.com', '*.example.com'));
  assert.ok(!hostMatchesDomain('example.com.evil.test', '*.example.com'));
  assert.ok(!hostMatchesDomain('evil-api.github.com', 'api.github.com'));
  assert.ok(hostAllowed('anything', []));
  assert.ok(!hostAllowed('evil.test', ['api.github.com']));
  assert.equal(scrubSecret(`a ${SECRET} b ${SECRET}`, SECRET), 'a [REDACTED] b [REDACTED]');
});

// ---------------------------------------------------------------------------
// Store policy
// ---------------------------------------------------------------------------

test('setWithPolicy stores policy and set preserves it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-cred-policy-'));
  try {
    const store = createStore(root);
    const creds = createCredentials({ home: root, store });
    const meta = await creds.setWithPolicy(
      'github',
      'token',
      'ghp-secret-4321',
      'GitHub PAT',
      'Call the GitHub API',
      ['bash', 'http', 'bash'],
      ['api.github.com', '*.github.com'],
    );
    assert.equal(meta.envVar, 'AMIRO_CRED_GITHUB_TOKEN');
    assert.deepEqual(meta.allowedTools, ['bash', 'http']);
    assert.deepEqual(meta.allowedDomains, ['api.github.com', '*.github.com']);
    assert.equal(meta.usageDescription, 'Call the GitHub API');

    const plain = await creds.set('github', 'token', 'ghp-rotated-9999', 'GitHub PAT');
    assert.deepEqual(plain.allowedDomains, ['api.github.com', '*.github.com']);
    assert.equal(plain.usageDescription, 'Call the GitHub API');

    const readOnly = await creds.listMetadataReadOnly();
    assert.equal(readOnly.length, 1);
    assert.equal(readOnly[0].envVar, 'AMIRO_CRED_GITHUB_TOKEN');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('read-only metadata never creates the key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-cred-ro-'));
  try {
    const store = createStore(root);
    const creds = createCredentials({ home: root, store });
    assert.deepEqual(await creds.listMetadataReadOnly(), []);
    await assert.rejects(fs.readFile(path.join(root, 'protected', 'store.key')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('writes are admin-only; reads are open', async () => {
  const h = await makeHarness();
  try {
    const body = {
      service: 'composio',
      field: 'api_key',
      value: SECRET,
      label: 'Composio',
      usageDescription: 'Toolkits',
      allowedTools: ['http'],
      allowedDomains: ['backend.composio.dev'],
    };
    const denied = await h.call('PUT', '/api/credentials', { body, user: USER });
    assert.equal(denied.status, 403);

    const created = await h.call('PUT', '/api/credentials', { body });
    assert.equal(created.status, 200);
    assert.equal(created.json.envVar, 'AMIRO_CRED_COMPOSIO_API_KEY');
    assert.deepEqual(created.json.allowedDomains, ['backend.composio.dev']);
    assert.ok(!created.raw.includes(SECRET), 'response leaked the secret');

    const listed = await h.call('GET', '/api/credentials', { user: USER });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.items.length, 1);
    assert.ok(!listed.raw.includes(SECRET));

    const deleted = await h.call('DELETE', '/api/credentials/:service/:field', {
      params: { service: 'composio', field: 'api_key' },
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, { success: true });
  } finally {
    await h.cleanup();
  }
});

test('broker injects the header, enforces domains and scrubs the secret', async () => {
  // A real local upstream that reflects the injected header.
  const upstream = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authorization: auth, leak: SECRET }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;

  const h = await makeHarness();
  try {
    await h.call('PUT', '/api/credentials', {
      body: {
        service: 'github',
        field: 'token',
        value: SECRET,
        allowedDomains: ['api.github.com'],
      },
    });

    const forbidden = await h.call('POST', '/api/credentials/broker', {
      body: { service: 'github', field: 'token', url: `${base}/echo` },
    });
    assert.equal(forbidden.status, 403);
    assert.ok(!forbidden.raw.includes(SECRET));

    await h.call('PUT', '/api/credentials', {
      body: {
        service: 'github',
        field: 'token',
        value: SECRET,
        allowedDomains: ['127.0.0.1'],
      },
    });
    const ok = await h.call('POST', '/api/credentials/broker', {
      body: { service: 'github', field: 'token', url: `${base}/echo` },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.status, 200);
    assert.ok(!ok.raw.includes(SECRET), 'broker leaked the secret');
    const echoed = JSON.parse(ok.json.body);
    assert.equal(echoed.authorization, 'Bearer [REDACTED]');
    assert.equal(echoed.leak, '[REDACTED]');
  } finally {
    upstream.close();
    await h.cleanup();
  }
});
