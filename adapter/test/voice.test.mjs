import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStore } from '../src/store.mjs';
import { createCredentials, maskedHint } from '../src/credentials.mjs';
import {
  register,
  ttsCatalog,
  sttCatalog,
  normalizeSpeechUrl,
  normalizeTranscriptionUrl,
  buildSettingsView,
} from '../src/routes/voice.mjs';

const USER = { id: 'user-1', role: 'user' };

// ---------------------------------------------------------------------------
// Harness: a fake app + ctx good enough to drive the real registered handlers.
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    raw: undefined,
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
      this.headersSent = true;
    },
    end(body) {
      this.raw = body;
    },
  };
}

async function makeHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amiro-voice-test-'));
  const store = createStore(root);
  const routes = new Map();
  const app = {
    get(p, h) { routes.set(`GET ${p}`, h); },
    put(p, h) { routes.set(`PUT ${p}`, h); },
    post(p, h) { routes.set(`POST ${p}`, h); },
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
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    },
    error(res, status, message) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(message) }));
    },
  };
  register(app, ctx);

  async function call(method, route, body = undefined, user = USER) {
    const handler = routes.get(`${method} ${route}`);
    assert.ok(handler, `route ${method} ${route} not registered`);
    const res = makeRes();
    await handler({ user, _body: body }, res);
    let parsed;
    if (res.raw !== undefined && typeof res.raw === 'string') {
      try { parsed = JSON.parse(res.raw); } catch { parsed = undefined; }
    }
    return { status: res.statusCode, res, json: parsed };
  }

  return { root, store, ctx, call, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

test('tts and stt catalogs match the backend contract', () => {
  assert.deepEqual(
    ttsCatalog().map((p) => p.id),
    ['openai', 'elevenlabs', 'deepgram', 'fish-audio', 'xai', 'custom-openai', 'browser-native'],
  );
  assert.deepEqual(
    sttCatalog().map((p) => p.id),
    ['deepgram', 'openai', 'groq', 'elevenlabs', 'xai', 'custom-openai', 'browser-native'],
  );
  const openai = ttsCatalog().find((p) => p.id === 'openai');
  assert.equal(openai.defaultModel, 'tts-1');
  assert.equal(openai.defaultVoice, 'alloy');
  assert.equal(openai.defaultBaseUrl, 'https://api.openai.com/v1');
  assert.equal(openai.voices.length, 11);
  assert.equal(openai.models.length, 3);
  assert.equal(openai.supportsBaseUrl, true);
  assert.equal(ttsCatalog().find((p) => p.id === 'custom-openai').requiresBaseUrl, true);
  assert.equal(ttsCatalog().find((p) => p.id === 'browser-native').keyless, true);
  assert.equal(sttCatalog().find((p) => p.id === 'browser-native').keyless, true);
});

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

test('speech URL normalization handles 9Router / custom-openai bases', () => {
  assert.equal(normalizeSpeechUrl('http://localhost:20128/v1'), 'http://localhost:20128/v1/audio/speech');
  assert.equal(normalizeSpeechUrl('http://localhost:20128/v1/'), 'http://localhost:20128/v1/audio/speech');
  assert.equal(normalizeSpeechUrl('http://localhost:20128'), 'http://localhost:20128/v1/audio/speech');
  assert.equal(normalizeSpeechUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/audio/speech');
  assert.equal(normalizeSpeechUrl('https://host/v1/audio/speech'), 'https://host/v1/audio/speech');
  assert.equal(normalizeSpeechUrl(''), 'https://api.openai.com/v1/audio/speech');
});

test('transcription URL normalization handles custom-openai bases', () => {
  assert.equal(normalizeTranscriptionUrl('http://localhost:20128/v1'), 'http://localhost:20128/v1/audio/transcriptions');
  assert.equal(normalizeTranscriptionUrl('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(normalizeTranscriptionUrl('https://api.openai.com'), 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(normalizeTranscriptionUrl('https://host/v1/audio/transcriptions'), 'https://host/v1/audio/transcriptions');
});

// ---------------------------------------------------------------------------
// Masking + settings roundtrip
// ---------------------------------------------------------------------------

test('maskedHint shows only the last four characters', () => {
  assert.equal(maskedHint('sk-super-secret-1234'), '••••1234');
  assert.equal(maskedHint('abc'), '••••');
  assert.equal(maskedHint(''), '••••');
});

test('credential store encrypts at rest and never leaks plaintext', async () => {
  const h = await makeHarness();
  try {
    const creds = createCredentials({ home: h.root, store: h.store });
    const meta = await creds.set('tts.openai', 'api_key', 'sk-plaintext-1234', 'OpenAI Speech API key');
    assert.equal(meta.hint, '••••1234');
    assert.equal(await creds.getPlaintext('tts.openai', 'api_key'), 'sk-plaintext-1234');

    const raw = await fs.readFile(path.join(h.root, 'protected', 'credentials.enc'), 'utf8');
    assert.ok(!raw.includes('sk-plaintext-1234'), 'plaintext must not appear on disk');

    const listed = await creds.listMetadata();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'tts.openai/api_key');
    assert.equal(listed[0].hint, '••••1234');

    assert.equal(await creds.delete('tts.openai', 'api_key'), true);
    assert.equal(await creds.getPlaintext('tts.openai', 'api_key'), null);
  } finally {
    await h.cleanup();
  }
});

test('GET settings returns defaults with browser-native configured', async () => {
  const h = await makeHarness();
  try {
    const { status, json } = await h.call('GET', '/api/voice/settings');
    assert.equal(status, 200);
    assert.equal(json.settings.ttsProvider, 'browser-native');
    assert.equal(json.settings.sttProvider, 'browser-native');
    assert.equal(json.settings.sttLanguage, 'en');
    assert.equal(json.ttsCatalog.length, 7);
    assert.equal(json.sttCatalog.length, 7);
    assert.equal(json.settings.ttsProviders['browser-native'].configured, true);
    assert.equal(json.settings.ttsProviders['browser-native'].apiKeyHint, null);
    assert.equal(json.settings.ttsProviders.openai.configured, false);
  } finally {
    await h.cleanup();
  }
});

test('PUT settings roundtrip persists config and masks the key', async () => {
  const h = await makeHarness();
  try {
    const { status, json } = await h.call('PUT', '/api/voice/settings', {
      ttsProvider: 'openai',
      readAloudEnabled: false,
      ttsProviderUpdate: {
        provider: 'openai',
        model: 'tts-1-hd',
        voiceId: 'nova',
        speed: 1.25,
        apiKey: 'sk-openai-secret-1234',
      },
      sttProviderUpdate: { provider: 'deepgram', model: 'nova-3', apiKey: 'dg-secret-9876' },
    });
    assert.equal(status, 200);
    assert.equal(json.settings.ttsProvider, 'openai');
    assert.equal(json.settings.readAloudEnabled, false);
    const openai = json.settings.ttsProviders.openai;
    assert.equal(openai.model, 'tts-1-hd');
    assert.equal(openai.voiceId, 'nova');
    assert.equal(openai.speed, 1.25);
    assert.equal(openai.configured, true);
    assert.equal(openai.apiKeyHint, '••••1234');
    const deepgram = json.settings.sttProviders.deepgram;
    assert.equal(deepgram.model, 'nova-3');
    assert.equal(deepgram.configured, true);
    assert.equal(deepgram.apiKeyHint, '••••9876');
    assert.ok(!JSON.stringify(json).includes('sk-openai-secret-1234'));
    assert.ok(!JSON.stringify(json).includes('dg-secret-9876'));

    // A fresh GET reflects the persisted config.
    const again = await h.call('GET', '/api/voice/settings');
    assert.equal(again.json.settings.ttsProvider, 'openai');
    assert.equal(again.json.settings.ttsProviders.openai.voiceId, 'nova');

    // Clearing removes the key.
    const cleared = await h.call('PUT', '/api/voice/settings', {
      ttsProviderUpdate: { provider: 'openai', clearApiKey: true },
    });
    assert.equal(cleared.json.settings.ttsProviders.openai.configured, false);
  } finally {
    await h.cleanup();
  }
});

test('PUT rejects unknown providers', async () => {
  const h = await makeHarness();
  try {
    const { status, json } = await h.call('PUT', '/api/voice/settings', { ttsProvider: 'nope' });
    assert.equal(status, 400);
    assert.match(json.error, /unknown voice provider/);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Proxy endpoints against a local upstream
// ---------------------------------------------------------------------------

async function withUpstream(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('synthesize normalizes the URL and streams audio bytes', async () => {
  const h = await makeHarness();
  let recorded = null;
  try {
    await withUpstream((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        recorded = { method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') };
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(Buffer.from([1, 2, 3, 4]));
      });
    }, async (port) => {
      const { status, res } = await h.call('POST', '/api/tts/synthesize', {
        provider: 'custom-openai',
        text: 'hello',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-router-1234',
      });
      assert.equal(status, 200);
      assert.equal(res.headers['Content-Type'], 'audio/mpeg');
      assert.deepEqual(Array.from(res.raw), [1, 2, 3, 4]);
      assert.equal(recorded.url, '/v1/audio/speech');
      assert.equal(recorded.method, 'POST');
      assert.equal(recorded.auth, 'Bearer sk-router-1234');
      const body = JSON.parse(recorded.body);
      assert.equal(body.model, 'tts-1');
      assert.equal(body.voice, 'alloy');
      assert.equal(body.response_format, 'mp3');
    });
  } finally {
    await h.cleanup();
  }
});

test('synthesize without a key returns a 400', async () => {
  const h = await makeHarness();
  try {
    const { status, json } = await h.call('POST', '/api/tts/synthesize', {
      provider: 'openai',
      text: 'hello',
    });
    assert.equal(status, 400);
    assert.match(json.error, /no API key/);

    const browser = await h.call('POST', '/api/tts/synthesize', {
      provider: 'browser-native',
      text: 'hello',
    });
    assert.equal(browser.status, 400);
  } finally {
    await h.cleanup();
  }
});

test('transcribe decodes base64 and returns the upstream transcript', async () => {
  const h = await makeHarness();
  let recorded = null;
  try {
    await withUpstream((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        recorded = { method: req.method, url: req.url, auth: req.headers.authorization, contentType: req.headers['content-type'] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'hello world' }));
      });
    }, async (port) => {
      const audio = Buffer.from('fake-audio-bytes').toString('base64');
      const { status, json } = await h.call('POST', '/api/stt/transcribe', {
        provider: 'custom-openai',
        audio,
        mimeType: 'audio/webm',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-router-1234',
      });
      assert.equal(status, 200);
      assert.equal(json.status, 'ok');
      assert.equal(json.text, 'hello world');
      assert.equal(json.providerId, 'custom-openai');
      assert.equal(recorded.url, '/v1/audio/transcriptions');
      assert.equal(recorded.auth, 'Bearer sk-router-1234');
      assert.match(recorded.contentType, /^multipart\/form-data; boundary=/);
    });
  } finally {
    await h.cleanup();
  }
});

test('transcribe rejects invalid base64 and missing keys', async () => {
  const h = await makeHarness();
  try {
    const bad = await h.call('POST', '/api/stt/transcribe', { provider: 'openai', audio: '' });
    assert.equal(bad.status, 400);

    const noKey = await h.call('POST', '/api/stt/transcribe', {
      provider: 'deepgram',
      audio: Buffer.from('x').toString('base64'),
    });
    assert.equal(noKey.status, 400);
    assert.match(noKey.json.error, /no API key/);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// buildSettingsView (pure)
// ---------------------------------------------------------------------------

test('buildSettingsView reflects key presence and propagates hints', () => {
  const settings = { sttLanguage: 'en', ttsProviders: {}, sttProviders: {} };
  const noHints = buildSettingsView(settings, new Map());
  assert.equal(noHints.tts['custom-openai'].configured, false);
  assert.equal(noHints.tts['custom-openai'].apiKeyHint, null);
  assert.equal(noHints.tts['custom-openai'].baseUrl, 'http://localhost:20128/v1');
  assert.equal(noHints.tts['custom-openai'].model, 'tts-1');

  const hints = new Map([['tts.custom-openai/api_key', '••••9999']]);
  const withKey = buildSettingsView(settings, hints);
  assert.equal(withKey.tts['custom-openai'].configured, true);
  assert.equal(withKey.tts['custom-openai'].apiKeyHint, '••••9999');

  // A shared bare key also configures the provider.
  const shared = buildSettingsView(settings, new Map([['openai/api_key', '••••1111']]));
  assert.equal(shared.tts.openai.configured, true);
  assert.equal(shared.tts.openai.apiKeyHint, '••••1111');

  // Keyless providers always report configured with no hint.
  assert.equal(noHints.tts['browser-native'].configured, true);
  assert.equal(noHints.tts['browser-native'].apiKeyHint, null);
});
