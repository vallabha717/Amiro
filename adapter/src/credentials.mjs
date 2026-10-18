// adapter/src/credentials.mjs -- encrypted credential store, backend-compatible.
//
// Mirrors backend/src/credentials.rs so the Node adapter and the Rust backend
// can share the same on-disk store at `$AMIRO_HOME/protected/`:
//
//   protected/store.key       32 random bytes, created atomically (mode 0600)
//   protected/credentials.enc JSON map `credential/<service>/<field>` ->
//                             { nonce, ciphertext, label?, createdAt, updatedAt }
//
// Values are sealed with AES-256-GCM under a fresh 12-byte nonce and the
// associated data `<service>/<field>`; the auth tag is appended to the
// ciphertext (matching the Rust `aes-gcm` crate's layout). Only metadata plus a
// masked four-character hint ever leaves this module.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROTECTED_DIR = 'protected';
const STORE_FILE = 'credentials.enc';
const KEY_FILE = 'store.key';
const MAX_VALUE_LEN = 8192;
const MAX_NAME_LEN = 64;
const NAME_RE = /^[a-z0-9._-]{1,64}$/;

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name.length <= MAX_NAME_LEN;
}

// Uppercase an identifier fragment and replace every non-alphanumeric character
// with `_`, so it is safe to splice into an environment variable name. Matches
// backend/src/credentials.rs `sanitize_env_part`.
export function sanitizeEnvPart(name) {
  return Array.from(String(name ?? ''))
    .map((character) => (/[a-z0-9]/i.test(character) ? character.toUpperCase() : '_'))
    .join('');
}

// The environment variable a credential is exported under, e.g. `github` +
// `token` -> `AMIRO_CRED_GITHUB_TOKEN`.
export function envVarName(service, field) {
  return `AMIRO_CRED_${sanitizeEnvPart(service)}_${sanitizeEnvPart(field)}`;
}

// Mask a secret to its last four characters (matches credentials.rs).
export function maskedHint(value) {
  const chars = Array.from(String(value ?? ''));
  if (chars.length <= 4) return '••••';
  return `••••${chars.slice(chars.length - 4).join('')}`;
}

function entryKey(service, field) {
  return `credential/${service}/${field}`;
}

function associatedData(service, field) {
  return `${service}/${field}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function createCredentials({ home, store, log } = {}) {
  if (!home) throw new Error('createCredentials requires a home directory');
  if (!store || typeof store.readJson !== 'function' || typeof store.writeJson !== 'function') {
    throw new Error('createCredentials requires a JSON store');
  }

  const protectedDir = path.join(home, PROTECTED_DIR);
  const keyFile = path.join(protectedDir, KEY_FILE);
  const storeFile = path.join(protectedDir, STORE_FILE);

  // Serialize read-modify-write so concurrent awaits cannot lose a credential.
  let tail = Promise.resolve();
  function withLock(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async function ensureKey() {
    await fs.mkdir(protectedDir, { recursive: true, mode: 0o700 }).catch(() => {});
    try {
      const bytes = await fs.readFile(keyFile);
      if (bytes.length !== 32) throw new Error('store key is not 32 bytes');
      return bytes;
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    const generated = crypto.randomBytes(32);
    try {
      await fs.writeFile(keyFile, generated, { flag: 'wx', mode: 0o600 });
      return generated;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Lost the creation race: the winner's key is authoritative.
        return fs.readFile(keyFile);
      }
      throw err;
    }
  }

  function encrypt(key, aad, plaintext) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      nonce: nonce.toString('base64'),
      ciphertext: Buffer.concat([body, tag]).toString('base64'),
    };
  }

  function decrypt(key, aad, nonceB64, ctB64) {
    const nonce = Buffer.from(nonceB64, 'base64');
    if (nonce.length !== 12) throw new Error('invalid nonce');
    const raw = Buffer.from(ctB64, 'base64');
    if (raw.length < 16) throw new Error('invalid ciphertext');
    const tag = raw.subarray(raw.length - 16);
    const data = raw.subarray(0, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  async function loadDoc() {
    const doc = await store.readJson(storeFile, {});
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  }

  function metadataFrom(service, field, record, key) {
    const value = decrypt(key, associatedData(service, field), record.nonce, record.ciphertext);
    const metadata = {
      id: `${service}/${field}`,
      service,
      field,
      hint: maskedHint(value),
      updatedAt: record.updatedAt || nowIso(),
      envVar: envVarName(service, field),
    };
    // Optional fields are omitted when empty, mirroring the Rust serializer.
    if (record.label !== undefined && record.label !== null && record.label !== '') {
      metadata.label = record.label;
    }
    if (record.usageDescription) metadata.usageDescription = record.usageDescription;
    if (Array.isArray(record.allowedTools) && record.allowedTools.length) {
      metadata.allowedTools = record.allowedTools;
    }
    if (Array.isArray(record.allowedDomains) && record.allowedDomains.length) {
      metadata.allowedDomains = record.allowedDomains;
    }
    return metadata;
  }

  // Trim, cap and de-duplicate a policy list, dropping blanks silently.
  function cleanPolicyList(items) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      const trimmed = String(item ?? '').trim();
      if (!trimmed || trimmed.length > 256 || out.includes(trimmed)) continue;
      out.push(trimmed);
    }
    return out;
  }

  function normalizePolicy(usageDescription, allowedTools, allowedDomains) {
    const usage = typeof usageDescription === 'string' ? usageDescription.trim() : '';
    if (usage.length > 1024) throw new Error('usageDescription is too long (max 1024 bytes)');
    return {
      usageDescription: usage || null,
      allowedTools: cleanPolicyList(allowedTools),
      allowedDomains: cleanPolicyList(allowedDomains),
    };
  }

  // Shared write path. `policy` is either an object or a resolver that receives
  // the existing record (so a plain `set` can preserve stored policy).
  async function writeCredential(service, field, value, label, policy) {
    if (!isValidName(service)) throw new Error('service must match [a-z0-9._-]{1,64}');
    if (!isValidName(field)) throw new Error('field must match [a-z0-9._-]{1,64}');
    if (typeof value !== 'string' || value.length === 0) throw new Error('value is required');
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_LEN) {
      throw new Error('value is too long (max 8192 bytes)');
    }
    const cleanLabel =
      label === undefined || label === null || String(label).trim() === ''
        ? null
        : String(label).trim();
    if (cleanLabel && cleanLabel.length > 256) {
      throw new Error('label is too long (max 256 bytes)');
    }

    return withLock(async () => {
      const key = await ensureKey();
      const doc = await loadDoc();
      const id = entryKey(service, field);
      const existing = doc[id];
      const resolved = typeof policy === 'function' ? policy(existing) : policy;
      const now = nowIso();
      const createdAt = (existing && existing.createdAt) || now;
      const { nonce, ciphertext } = encrypt(key, associatedData(service, field), value);
      const record = { nonce, ciphertext, label: cleanLabel, createdAt, updatedAt: now };
      if (resolved && resolved.usageDescription) {
        record.usageDescription = resolved.usageDescription;
      }
      if (resolved && resolved.allowedTools && resolved.allowedTools.length) {
        record.allowedTools = resolved.allowedTools;
      }
      if (resolved && resolved.allowedDomains && resolved.allowedDomains.length) {
        record.allowedDomains = resolved.allowedDomains;
      }
      doc[id] = record;
      await store.writeJson(storeFile, doc);
      return metadataFrom(service, field, record, key);
    });
  }

  // Store (or replace) a credential, preserving any policy already stored for
  // the slot. Mirrors the Rust `set`.
  async function set(service, field, value, label) {
    return writeCredential(service, field, value, label, (existing) => ({
      usageDescription: (existing && existing.usageDescription) || null,
      allowedTools: Array.isArray(existing && existing.allowedTools) ? existing.allowedTools : [],
      allowedDomains: Array.isArray(existing && existing.allowedDomains)
        ? existing.allowedDomains
        : [],
    }));
  }

  // Store (or replace) a credential together with its Vellum-style policy.
  async function setWithPolicy(
    service,
    field,
    value,
    label,
    usageDescription,
    allowedTools,
    allowedDomains,
  ) {
    const policy = normalizePolicy(usageDescription, allowedTools, allowedDomains);
    return writeCredential(service, field, value, label, policy);
  }

  async function getPlaintext(service, field) {
    if (!isValidName(service) || !isValidName(field)) return null;
    return withLock(async () => {
      const doc = await loadDoc();
      const record = doc[entryKey(service, field)];
      if (!record) return null;
      const key = await ensureKey();
      return decrypt(key, associatedData(service, field), record.nonce, record.ciphertext);
    });
  }

  async function del(service, field) {
    if (!isValidName(service) || !isValidName(field)) return false;
    return withLock(async () => {
      const doc = await loadDoc();
      const id = entryKey(service, field);
      if (!(id in doc)) return false;
      delete doc[id];
      await store.writeJson(storeFile, doc);
      return true;
    });
  }

  async function listMetadata() {
    return withLock(async () => {
      const doc = await loadDoc();
      const key = await ensureKey();
      const items = [];
      for (const [id, record] of Object.entries(doc)) {
        if (!id.startsWith('credential/')) continue;
        const rest = id.slice('credential/'.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) continue;
        const service = rest.slice(0, slash);
        const field = rest.slice(slash + 1);
        try {
          items.push(metadataFrom(service, field, record, key));
        } catch (err) {
          log?.('warn', 'credential metadata decrypt failed', { service, field, error: String(err && err.message) });
        }
      }
      items.sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : (a.updatedAt < b.updatedAt ? 1 : -1)));
      return items;
    });
  }

  // Synchronous-ish read-only catalog for prompt building. Never creates the
  // master key, so a turn with no stored credentials has no side effects.
  // Mirrors the Rust `list_metadata_sync`.
  async function listMetadataReadOnly() {
    let key;
    try {
      key = await fs.readFile(keyFile);
      if (key.length !== 32) return [];
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const doc = await loadDoc();
    const items = [];
    for (const [id, record] of Object.entries(doc)) {
      if (!id.startsWith('credential/')) continue;
      const rest = id.slice('credential/'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const service = rest.slice(0, slash);
      const field = rest.slice(slash + 1);
      try {
        items.push(metadataFrom(service, field, record, key));
      } catch (err) {
        log?.('warn', 'credential metadata decrypt failed', { service, field, error: String(err && err.message) });
      }
    }
    items.sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : (a.updatedAt < b.updatedAt ? 1 : -1)));
    return items;
  }

  // Build a metadata-only credential catalog for the agent prompt. Never
  // contains a value. Mirrors backend/src/agent.rs build_credential_prompt_block.
  async function buildPromptBlock() {
    const items = await listMetadataReadOnly();
    if (items.length === 0) return '';
    const lines = [
      '## Stored Credentials (Vault)',
      "The following credentials are stored encrypted in Amiro's vault and pre-injected into your tool execution environment as environment variables. Never echo or print raw secret values in chat output; reference them by their environment variable name (e.g. in bash commands or MCP headers) or via brokered tools:",
    ];
    for (const item of items) {
      let line = `- ${item.service}/${item.field} ($${item.envVar})`;
      if (item.label) line += `: ${item.label}`;
      if (item.usageDescription) line += ` — ${item.usageDescription}`;
      if (Array.isArray(item.allowedDomains) && item.allowedDomains.length) {
        line += ` [allowed domains: ${item.allowedDomains.join(', ')}]`;
      }
      lines.push(line);
    }
    return `${lines.join('\n')}\n`;
  }

  return {
    set,
    setWithPolicy,
    getPlaintext,
    delete: del,
    listMetadata,
    listMetadataReadOnly,
    buildPromptBlock,
  };
}
