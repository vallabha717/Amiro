// adapter/src/fsbrowse.mjs -- server-side filesystem browser for folder picker.
//
// Security model (list-only, never returns file contents):
//   - Allowed roots: AMIRO_BROWSE_ROOTS (colon or comma separated absolute paths).
//     Default: /root, /home, /srv, /opt, /var/www, /tmp
//   - Denied paths: exact + prefix deny list (sensitive credential/config dirs).
//     Both exact match and prefix (with path separator) are denied. Denied paths
//     are not listed and cannot be entered.
//   - Symlink containment: realpath-resolve the requested path and re-check it
//     is inside an allowed root. A symlink pointing outside is denied even if the
//     link itself is inside.
//   - Path must be absolute. Relative or non-absolute requests are rejected.
//   - No file contents are ever read or returned.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOTS = ['/root', '/home', '/srv', '/opt', '/var/www', '/tmp'];

// Deny list. The two runtime entries are real on-disk directories of the
// runtime engine (`~/.jcode` and its config subtree, including the pre-rename
// credential layout). They stay denied so no Amiro surface can ever list or
// enter engine state; Amiro itself never needs to browse them.
// The runtime home actually in use is appended as well, so the deny list still
// covers the engine when AMIRO_RUNTIME_HOME points somewhere else.
const ENGINE_STATE_DENY = ['/root/.jcode', '/root/.config/jcode'];

function runtimeHomeDenyEntries() {
  const home =
    process.env.AMIRO_RUNTIME_HOME ||
    process.env.AMIRO_JCODE_HOME ||
    process.env.JCODE_HOME ||
    path.join(os.homedir(), '.jcode');
  const configDir = process.env.JCODE_CONFIG_HOME || path.join(os.homedir(), '.config', 'jcode');
  return [path.resolve(home), path.resolve(configDir)];
}

const DENY_EXACT = new Set([
  ...ENGINE_STATE_DENY,
  ...runtimeHomeDenyEntries(),
  '/root/.amiro-preview',
  '/root/.ssh',
  '/root/.aws',
  '/root/.gnupg',
  '/etc/letsencrypt',
  '/etc/ssl/private',
  '/root/.secrets',
]);

// Deny prefixes: anything at or under these paths is denied.
const DENY_PREFIXES = [
  ...ENGINE_STATE_DENY,
  ...runtimeHomeDenyEntries(),
  '/root/.amiro-preview',
  '/root/.ssh',
  '/root/.aws',
  '/root/.gnupg',
  '/etc/letsencrypt',
  '/etc/ssl/private',
  '/root/.secrets',
];

function parseRootsEnv() {
  const raw = process.env.AMIRO_BROWSE_ROOTS;
  if (raw == null || String(raw).trim() === '') return [...DEFAULT_ROOTS];
  const parts = String(raw)
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Only keep absolute paths
  return parts.filter((p) => path.isAbsolute(p));
}

export function resolveBrowseRoots() {
  const roots = parseRootsEnv();
  // Normalize: resolve trailing slashes, dedupe
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    const n = path.resolve(r);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function isDenied(absPath) {
  const normalized = path.resolve(absPath);
  if (DENY_EXACT.has(normalized)) return true;
  for (const prefix of DENY_PREFIXES) {
    if (normalized === prefix) return true;
    if (normalized.startsWith(prefix + path.sep)) return true;
  }
  return false;
}

function isInsideAllowedRoots(absPath, roots) {
  const normalized = path.resolve(absPath);
  for (const root of roots) {
    if (normalized === root) return true;
    if (normalized.startsWith(root + path.sep)) return true;
  }
  return false;
}

export function isPathDenied(absPath) {
  return isDenied(path.resolve(absPath));
}

export function isPathInsideRoots(absPath, roots) {
  return isInsideAllowedRoots(path.resolve(absPath), roots || resolveBrowseRoots());
}

/**
 * Validate that `absPath` is usable as a project directory.
 * Throws with .status for HTTP mapping. Checks:
 *   - must be absolute
 *   - must not be denied
 *   - must be inside allowed roots (after realpath)
 *   - must exist and be a directory
 */
export async function assertUsableProjectDirectory(absPath) {
  if (!absPath || typeof absPath !== 'string') {
    const err = new Error('path is required');
    err.status = 400;
    return Promise.reject(err);
  }
  if (!path.isAbsolute(absPath)) {
    const err = new Error('path must be absolute');
    err.status = 400;
    throw err;
  }
  const roots = resolveBrowseRoots();

  // Check raw path denied before resolving
  if (isDenied(absPath)) {
    const err = new Error('access denied');
    err.status = 403;
    throw err;
  }

  // Realpath resolve for symlink containment
  let real;
  try {
    real = await fs.realpath(absPath);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      const err = new Error('path does not exist');
      err.status = 400;
      throw err;
    }
    throw e;
  }

  // Re-check containment and deny after realpath
  if (isDenied(real)) {
    const err = new Error('access denied');
    err.status = 403;
    throw err;
  }
  if (!isInsideAllowedRoots(real, roots)) {
    const err = new Error('path is outside allowed roots');
    err.status = 403;
    throw err;
  }

  let st;
  try {
    st = await fs.stat(real);
  } catch (e) {
    const err = new Error('path does not exist');
    err.status = 400;
    throw err;
  }
  if (!st.isDirectory()) {
    const err = new Error('path is not a directory');
    err.status = 400;
    throw err;
  }

  return { resolvedPath: real, requestedPath: path.resolve(absPath) };
}

/**
 * List directory contents. Security: realpath + containment + deny checks.
 * Returns { path, parent, roots, entries, truncated }
 * entries: { name, path, kind: "dir"|"file", isGitRepo } sorted dirs first, then alpha.
 * Never reads file contents. Caps entries at 500.
 */
export async function listDirectory(absPath) {
  if (!absPath || typeof absPath !== 'string') {
    const err = new Error('path is required');
    err.status = 400;
    throw err;
  }
  if (!path.isAbsolute(absPath)) {
    const err = new Error('path must be absolute');
    err.status = 400;
    throw err;
  }

  const roots = resolveBrowseRoots();

  if (isDenied(absPath)) {
    const err = new Error('access denied');
    err.status = 403;
    throw err;
  }

  let real;
  try {
    real = await fs.realpath(absPath);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      const err = new Error('path does not exist');
      err.status = 400;
      throw err;
    }
    throw e;
  }

  if (isDenied(real)) {
    const err = new Error('access denied');
    err.status = 403;
    throw err;
  }
  if (!isInsideAllowedRoots(real, roots)) {
    const err = new Error('path is outside allowed roots');
    err.status = 403;
    throw err;
  }

  let st;
  try {
    st = await fs.stat(real);
  } catch (e) {
    const err = new Error('path does not exist');
    err.status = 400;
    throw err;
  }
  if (!st.isDirectory()) {
    const err = new Error('path is not a directory');
    err.status = 400;
    throw err;
  }

  let names;
  try {
    names = await fs.readdir(real);
  } catch (e) {
    const err = new Error('unable to read directory');
    err.status = 403;
    throw err;
  }

  const MAX_ENTRIES = 500;
  let truncated = false;
  // Include hidden files/dirs? Per spec: hidden handling included only for directories?
  // Decision: include all entries (including dotfiles) but filter directory entries for
  // the picker? We list everything, frontend filters. Document: hidden entries are included.
  const raw = names.slice(0, MAX_ENTRIES + 1);
  if (raw.length > MAX_ENTRIES) {
    truncated = true;
    raw.length = MAX_ENTRIES;
  }

  const entries = [];
  for (const name of raw) {
    const full = path.join(real, name);
    // Skip denied children
    if (isDenied(full)) continue;
    let entStat;
    let kind = 'file';
    try {
      entStat = await fs.lstat(full);
      if (entStat.isDirectory()) kind = 'dir';
      else if (entStat.isSymbolicLink()) {
        // Resolve symlink target kind, but still list as file/dir based on target.
        // If symlink escapes roots, skip it.
        try {
          const target = await fs.realpath(full);
          if (isDenied(target) || !isInsideAllowedRoots(target, roots)) {
            continue;
          }
          const tStat = await fs.stat(target);
          kind = tStat.isDirectory() ? 'dir' : 'file';
        } catch {
          kind = 'file';
        }
      }
    } catch {
      kind = 'file';
    }

    let isGitRepo = false;
    if (kind === 'dir') {
      try {
        const gitStat = await fs.stat(path.join(full, '.git'));
        if (gitStat.isDirectory() || gitStat.isFile()) isGitRepo = true;
      } catch {
        /* not a git repo */
      }
    }

    entries.push({ name, path: full, kind, isGitRepo });
  }

  // Sort: directories first, then alphabetically (case-insensitive)
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const parent = real !== path.dirname(real) ? path.dirname(real) : null;
  // But if parent would escape roots, we still show it; browsing will deny if they try to enter a denied/outside path.
  // For containment UX, parent is always dirname.

  return {
    path: real,
    parent,
    roots,
    entries,
    truncated,
  };
}

/**
 * Stat a single path (no listing). Returns { path, name, kind, exists, usable }.
 * usable = exists && isDirectory && inside roots && not denied.
 * Never reads file contents.
 */
export async function statPath(absPath) {
  if (!absPath || typeof absPath !== 'string') {
    const err = new Error('path is required');
    err.status = 400;
    throw err;
  }
  if (!path.isAbsolute(absPath)) {
    const err = new Error('path must be absolute');
    err.status = 400;
    throw err;
  }

  const roots = resolveBrowseRoots();
  const name = path.basename(path.resolve(absPath)) || absPath;

  if (isDenied(absPath)) {
    return { path: path.resolve(absPath), name, kind: 'unknown', exists: false, usable: false, denied: true };
  }

  let real;
  try {
    real = await fs.realpath(absPath);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return { path: path.resolve(absPath), name, kind: 'unknown', exists: false, usable: false, denied: false };
    }
    throw e;
  }

  if (isDenied(real)) {
    return { path: real, name, kind: 'unknown', exists: true, usable: false, denied: true };
  }
  if (!isInsideAllowedRoots(real, roots)) {
    return { path: real, name, kind: 'unknown', exists: true, usable: false, denied: false, outsideRoots: true };
  }

  let st;
  try {
    st = await fs.stat(real);
  } catch {
    return { path: real, name, kind: 'unknown', exists: false, usable: false, denied: false };
  }

  const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  const usable = st.isDirectory();
  return { path: real, name, kind, exists: true, usable, denied: false };
}
