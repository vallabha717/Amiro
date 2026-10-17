import test from 'node:test';
import assert from 'node:assert/strict';
import {
  joinCatalog,
  _normalizeMechanismForTest as normalizeMechanism,
  _redactForTest as redact,
} from '../src/providers.mjs';

// Regression test: the full jcode-supported provider list is the UNION of
// `amiro provider list --json` (SKU catalog) and `amiro auth status --json`
// (auth superset). Dropping either side regresses the catalog (28 instead of
// ~55). These fixtures mirror the live engine shapes on a smaller scale.

function authEntry(overrides) {
  return {
    id: 'openai',
    display_name: 'OpenAI',
    auth_kind: 'API key',
    status: 'available',
    method: null,
    credential_source: null,
    health: null,
    recommended: false,
    ...overrides,
  };
}

function listEntry(overrides) {
  return {
    id: 'openai',
    display_name: 'OpenAI',
    auth_kind: 'API key',
    recommended: false,
    detail: null,
    aliases: [],
    ...overrides,
  };
}

const AUTH_FIXTURE = [
  authEntry({ id: 'openai', status: 'available', recommended: true }),
  authEntry({ id: 'claude', display_name: 'Claude', auth_kind: 'OAuth', status: 'available' }),
  // Auth-only id: absent from `provider list`, must still appear.
  authEntry({ id: 'orcarouter', display_name: 'OrcaRouter', status: 'not_configured' }),
  // Device-code flow counts as OAuth-capable.
  authEntry({ id: 'copilot', display_name: 'Copilot', auth_kind: 'Device code', status: 'not_configured' }),
];

const LIST_FIXTURE = [
  listEntry({ id: 'openai', recommended: true, detail: 'Flagship models', aliases: ['gpt'] }),
  listEntry({ id: 'claude', display_name: 'Claude', auth_kind: 'OAuth' }),
  // List-only ids: absent from `auth status`, must still appear.
  listEntry({ id: 'auto', display_name: 'Auto-detect', auth_kind: null }),
  listEntry({ id: 'google', display_name: 'Google/Gmail', auth_kind: 'OAuth' }),
];

test('catalog is the union of auth status and provider list', () => {
  const out = joinCatalog(LIST_FIXTURE, AUTH_FIXTURE);
  const ids = new Set(out.map((p) => p.id));
  for (const id of ['openai', 'claude', 'orcarouter', 'copilot', 'auto', 'google']) {
    assert.ok(ids.has(id), `missing provider ${id}`);
  }
  assert.equal(out.length, 6, 'overlap must be merged, not duplicated');
});

test('list-only entries are present and disconnected', () => {
  const out = joinCatalog(LIST_FIXTURE, AUTH_FIXTURE);
  const auto = out.find((p) => p.id === 'auto');
  assert.equal(auto.connected, false);
  assert.equal(auto.status, 'not_configured');
  assert.equal(auto.mechanism, 'automatic');
  const google = out.find((p) => p.id === 'google');
  assert.equal(google.connected, false);
  assert.equal(google.mechanism, 'oauth');
  assert.equal(google.canStartOauth, true);
});

test('mechanisms drive oauth/api-key capabilities', () => {
  const out = joinCatalog(LIST_FIXTURE, AUTH_FIXTURE);
  const byId = new Map(out.map((p) => [p.id, p]));
  assert.equal(byId.get('claude').canStartOauth, true);
  assert.equal(byId.get('claude').canAcceptApiKey, false);
  assert.equal(byId.get('copilot').canStartOauth, true);
  assert.equal(byId.get('openai').canStartOauth, false);
  assert.equal(byId.get('openai').canAcceptApiKey, true);
});

test('overlap merges list detail into the auth entry', () => {
  const out = joinCatalog(LIST_FIXTURE, AUTH_FIXTURE);
  const openai = out.find((p) => p.id === 'openai');
  assert.equal(openai.detail, 'Flagship models');
  assert.deepEqual(openai.aliases, ['gpt']);
  assert.equal(openai.connected, true, 'auth connection state wins');
});

test('credential sources are redacted', () => {
  const out = joinCatalog(LIST_FIXTURE, [
    authEntry({ credential_source: 'env OPENAI_API_KEY=sk-secretvalue123' }),
  ]);
  const source = out[0].credentialSource;
  assert.ok(!source.includes('sk-secretvalue123'), `key material leaked: ${source}`);
  assert.ok(source.includes('[REDACTED]'), `expected redaction marker: ${source}`);
});

test('recommended providers sort first', () => {
  const out = joinCatalog(LIST_FIXTURE, AUTH_FIXTURE);
  assert.equal(out[0].id, 'openai');
});

test('mechanism normalization covers engine auth kinds', () => {
  assert.equal(normalizeMechanism('OAuth', 'claude'), 'oauth');
  assert.equal(normalizeMechanism('API key', 'openai'), 'api-key');
  assert.equal(normalizeMechanism('API key / CLI', 'x'), 'api-key');
  assert.equal(normalizeMechanism('Device code', 'copilot'), 'device-code');
  assert.equal(normalizeMechanism('Local endpoint', 'ollama'), 'local-endpoint');
  assert.equal(normalizeMechanism('CLI', 'x'), 'cli');
  assert.equal(normalizeMechanism(null, 'auto'), 'automatic');
  assert.equal(normalizeMechanism(null, 'other'), 'unknown');
});

test('redaction keeps non-secret values intact', () => {
  assert.equal(redact(null), null);
  assert.equal(redact('oauth:browser-flow'), 'oauth:browser-flow');
});
