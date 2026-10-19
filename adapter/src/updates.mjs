// adapter/src/updates.mjs -- release-check and one-click update helpers.
//
// The General page shows the running version and, when a newer GitHub
// release exists, offers the same update `amiro update` performs -- without
// making the user open a terminal. This module holds the logic both the
// Node adapter route (`routes/system.mjs`) and tests exercise:
//
//   * `parseVersion` / `compareVersions` / `isNewer`: strict semver-ish
//     comparison ("v1.26.0", "1.26.0", "1.26.0-rc.1" all work; anything
//     unparseable is never "newer", so a weird tag can never trigger
//     an update prompt).
//   * `checkForUpdate`: asks `https://api.github.com/repos/<owner>/<repo>`
//     `/releases/latest` (same `AMIRO_REPO` env `install.sh` honours) and
//     returns `{ current, latest, updateAvailable, releaseUrl, publishedAt }`
//     plus a per-process cache so the General page's 15s poll does not
//     hammer the GitHub API (10 minute TTL).
//   * `startUpdate`: replays the exact `amiro update` command -- the release
//     `install.sh` with `AMIRO_NO_START=1`, detached -- so the HTTP response
//     returns before the restart kills the server. The one hard rule: the
//     version argument is validated with `parseVersion` first and only ever
//     passed as a single argv element (`--version <v>`), never interpolated
//     into a shell string.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GITHUB_API = 'https://api.github.com';
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached = null; // { at, repo, result }

export function repoSlug() {
  return process.env.AMIRO_REPO || 'vallabha717/Amiro';
}

export function installScriptUrl(version) {
  if (version) {
    return `https://github.com/${repoSlug()}/releases/download/${version}/install.sh`;
  }
  return `https://github.com/${repoSlug()}/releases/latest/download/install.sh`;
}

// "v1.26.0" -> { major: 1, minor: 26, patch: 0, prerelease: null }.
// Returns null when the string is not a plain dotted version.
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw
    .trim()
    .replace(/^[vV]/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
  };
}

// -1 when a < b, 0 when equal, 1 when a > b. A prerelease is older than
// the same release ("1.26.0-rc.1" < "1.26.0"); "dev"/unparseable inputs
// compare as 0 so they never claim to be newer or older.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease == null) return 1;
  if (pb.prerelease == null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

export function isNewer(current, latest) {
  return compareVersions(current, latest) < 0;
}

async function fetchLatestRelease({ fetchImpl, repo, timeoutMs = 10000 } = {}) {
  const fetchFn = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${GITHUB_API}/repos/${repo}/releases/latest`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'amiro-update-check',
      },
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
    const body = await res.json();
    return { release: body };
  } finally {
    clearTimeout(timer);
  }
}

// Check GitHub for a newer release. Never throws: network/DNS/rate-limit
// failures come back as `{ checkFailed: true }` so the UI can say
// "couldn't check" instead of breaking the General page.
export async function checkForUpdate(current, opts = {}) {
  const repo = opts.repo || repoSlug();
  const now = Date.now();
  if (
    cached &&
    cached.repo === repo &&
    now - cached.at < CACHE_TTL_MS &&
    (!opts.current || cached.current === current)
  ) {
    return cached.result;
  }
  let result;
  try {
    const { release, notFound } = await fetchLatestRelease({
      fetchImpl: opts.fetchImpl,
      repo,
      timeoutMs: opts.timeoutMs,
    });
    if (notFound || !release || typeof release.tag_name !== 'string') {
      result = {
        current,
        latest: null,
        updateAvailable: false,
        releaseUrl: `https://github.com/${repo}/releases`,
        publishedAt: null,
        checkFailed: !notFound,
        noReleases: !!notFound,
      };
    } else {
      const latest = release.tag_name;
      result = {
        current,
        latest,
        updateAvailable: isNewer(current, latest),
        releaseUrl:
          release.html_url || `https://github.com/${repo}/releases/latest`,
        publishedAt: release.published_at || null,
        checkFailed: false,
        noReleases: false,
      };
    }
  } catch {
    result = {
      current,
      latest: null,
      updateAvailable: false,
      releaseUrl: `https://github.com/${repo}/releases`,
      publishedAt: null,
      checkFailed: true,
      noReleases: false,
    };
  }
  cached = { at: now, repo, current, result };
  return result;
}

export function clearUpdateCache() {
  cached = null;
}

// Run the release installer exactly like `amiro update` does, detached:
// the child outlives the response (it will restart the server) and stdio
// goes to the server log. No shell is involved at any step: install.sh is
// downloaded with fetch (from the fixed release URL, never user input),
// written to a temp file, and executed as `bash <file> -s -- [--version
// <v>]` with the version passed as a single argv element -- after it has
// passed `parseVersion`. A caller-supplied version that is not a plain
// dotted version throws before anything is spawned.
export async function startUpdate({
  version,
  logFile,
  fetchImpl,
  spawnImpl,
} = {}) {
  if (version != null && !parseVersion(version)) {
    throw new Error(`refusing to update to unparseable version: ${version}`);
  }
  const fetchFn = fetchImpl || fetch;
  const res = await fetchFn(installScriptUrl(version), {
    headers: { 'User-Agent': 'amiro-update' },
  });
  if (!res.ok) {
    throw new Error(`could not download installer (HTTP ${res.status})`);
  }
  const script = await res.text();
  if (!script.startsWith('#!/usr/bin/env bash')) {
    throw new Error('downloaded installer failed the sanity check');
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'amiro-update-'));
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const doSpawn = spawnImpl || spawn;
  const args = [scriptPath, '-s', '--'];
  if (version) args.push('--version', version);
  const child = doSpawn('bash', args, {
    detached: true,
    stdio: logFile ? ['ignore', 'ignore', 'ignore'] : 'ignore',
    env: { ...process.env, AMIRO_NO_START: '0' },
  });
  child.unref();
  return { started: true, version: version || 'latest', pid: child.pid };
}
