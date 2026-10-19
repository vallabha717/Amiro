import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  compareVersions,
  isNewer,
  checkForUpdate,
  clearUpdateCache,
  startUpdate,
  installScriptUrl,
} from '../src/updates.mjs';

test('parseVersion handles plain and v-prefixed semver', () => {
  assert.deepEqual(parseVersion('v1.26.0'), { major: 1, minor: 26, patch: 0, prerelease: null });
  assert.deepEqual(parseVersion('1.26.0'), { major: 1, minor: 26, patch: 0, prerelease: null });
  assert.deepEqual(parseVersion('v1.27.0-rc.1'), { major: 1, minor: 27, patch: 0, prerelease: 'rc.1' });
  assert.equal(parseVersion('dev'), null);
  assert.equal(parseVersion('1.26'), null);
  assert.equal(parseVersion('1.26.0.1'), null);
  assert.equal(parseVersion('; rm -rf /'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
});

test('compareVersions orders semver correctly', () => {
  assert.equal(compareVersions('1.26.0', '1.27.0'), -1);
  assert.equal(compareVersions('v1.27.0', '1.26.0'), 1);
  assert.equal(compareVersions('1.26.0', '1.26.0'), 0);
  assert.equal(compareVersions('1.26.0-rc.1', '1.26.0'), -1);
  assert.equal(compareVersions('1.26.0', '1.26.0-rc.1'), 1);
  // Unparseable input never claims newer or older.
  assert.equal(compareVersions('dev', '1.26.0'), 0);
  assert.equal(compareVersions('1.26.0', 'dev'), 0);
  assert.equal(compareVersions('dev', 'dev'), 0);
});

test('isNewer returns true only for strictly greater versions', () => {
  assert.equal(isNewer('1.26.0', 'v1.27.0'), true);
  assert.equal(isNewer('1.26.0', '1.26.0'), false);
  assert.equal(isNewer('v1.27.0', '1.26.0'), false);
  assert.equal(isNewer('dev', 'v1.27.0'), false);
});

test('checkForUpdate parses latest release and sets updateAvailable', async () => {
  clearUpdateCache();
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v1.27.0',
      html_url: 'https://github.com/vallabha717/Amiro/releases/tag/v1.27.0',
      published_at: '2026-10-19T00:00:00Z',
    }),
  });

  const res = await checkForUpdate('1.26.0', { fetchImpl: mockFetch });
  assert.equal(res.current, '1.26.0');
  assert.equal(res.latest, 'v1.27.0');
  assert.equal(res.updateAvailable, true);
  assert.equal(res.checkFailed, false);
  assert.equal(res.noReleases, false);
});

test('checkForUpdate degrades gracefully when offline / rate-limited', async () => {
  clearUpdateCache();
  const mockFetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  };

  const res = await checkForUpdate('1.26.0', { fetchImpl: mockFetch });
  assert.equal(res.current, '1.26.0');
  assert.equal(res.latest, null);
  assert.equal(res.updateAvailable, false);
  assert.equal(res.checkFailed, true);
});

test('checkForUpdate recognizes 404 as no-releases-yet', async () => {
  clearUpdateCache();
  const mockFetch = async () => ({
    ok: false,
    status: 404,
  });

  const res = await checkForUpdate('1.26.0', { fetchImpl: mockFetch });
  assert.equal(res.noReleases, true);
  assert.equal(res.updateAvailable, false);
  assert.equal(res.checkFailed, false);
});

test('startUpdate refuses unparseable version string', async () => {
  await assert.rejects(
    () => startUpdate({ version: 'invalid;rm -rf /' }),
    /unparseable version/,
  );
});

test('startUpdate refuses spoofed installer without bash shebang', async () => {
  const mockFetch = async () => ({
    ok: true,
    text: async () => 'echo malicious',
  });
  await assert.rejects(
    () => startUpdate({ version: 'v1.27.0', fetchImpl: mockFetch }),
    /sanity check/,
  );
});

test('startUpdate executes bash detached with validated argv', async () => {
  let spawned = null;
  const mockFetch = async (url) => {
    assert.equal(url, installScriptUrl('v1.27.0'));
    return {
      ok: true,
      text: async () => '#!/usr/bin/env bash\nexit 0\n',
    };
  };
  const mockSpawn = (cmd, args, opts) => {
    spawned = { cmd, args, opts };
    return { pid: 4242, unref() {} };
  };

  const res = await startUpdate({
    version: 'v1.27.0',
    fetchImpl: mockFetch,
    spawnImpl: mockSpawn,
  });
  assert.equal(res.started, true);
  assert.equal(res.version, 'v1.27.0');
  assert.equal(res.pid, 4242);
  assert.equal(spawned.cmd, 'bash');
  assert.equal(spawned.args.at(-2), '--version');
  assert.equal(spawned.args.at(-1), 'v1.27.0');
  assert.equal(spawned.opts.detached, true);
});
