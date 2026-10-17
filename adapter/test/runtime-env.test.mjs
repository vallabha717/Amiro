// adapter/test/runtime-env.test.mjs -- how the adapter wires the runtime engine.
//
// Locks down the environment contract with the engine CLI, which is where a real
// regression lived:
//   * the adapter's own AMIRO_HOME (application data home) must never be handed
//     to the engine, because the engine reads AMIRO_HOME as *its* home and then
//     looks for provider credentials in <app home>/config/jcode. That made
//     connected API-key providers (opencode-go, openrouter, ...) report
//     not_configured and drop out of the model catalog;
//   * a runtime home is only exported when an operator configured one;
//   * the credential directory mirrors the engine's own rule (configured home,
//     else the XDG config directory).
// Hermetic: no engine process is started.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  buildRuntimeCliEnv,
  configuredRuntimeHome,
  describeRuntimeCli,
  resolveRuntimeBin,
  resolveRuntimeConfigDir,
} from '../src/runtime.mjs';

const HOME_KEYS = [
  'AMIRO_RUNTIME_HOME',
  'AMIRO_JCODE_HOME',
  'JCODE_HOME',
  'AMIRO_HOME',
  'XDG_CONFIG_HOME',
  'AMIRO_RUNTIME_BIN',
  'AMIRO_JCODE_BIN',
  'JCODE_BIN',
  'JCODE_NO_TELEMETRY',
];

function withEnv(values, fn) {
  const saved = {};
  for (const key of HOME_KEYS) saved[key] = process.env[key];
  try {
    for (const key of HOME_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    return fn();
  } finally {
    for (const key of HOME_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('the app data home is never exported to the engine', () => {
  withEnv({ AMIRO_HOME: '/root/.amiro-preview' }, () => {
    const env = buildRuntimeCliEnv({});
    assert.equal(env.AMIRO_HOME, undefined, 'AMIRO_HOME means "engine home" to the engine');
    assert.equal(env.JCODE_HOME, undefined, 'no home configured, so none may be invented');
    assert.equal(env.AMIRO_RUNTIME_HOME, undefined);
    assert.equal(env.JCODE_NO_TELEMETRY, '1');
    // Everything else is inherited, so the engine keeps its own PATH/HOME/etc.
    assert.equal(env.PATH, process.env.PATH);
  });
});

test('a configured runtime home is exported under both names', () => {
  withEnv({}, () => {
    const configured = buildRuntimeCliEnv({ runtimeCliHome: '/srv/runtime-home' });
    assert.equal(configured.JCODE_HOME, '/srv/runtime-home');
    assert.equal(configured.AMIRO_RUNTIME_HOME, '/srv/runtime-home');
  });
  withEnv({ AMIRO_RUNTIME_HOME: '/srv/from-env' }, () => {
    const fromEnv = buildRuntimeCliEnv({});
    assert.equal(fromEnv.JCODE_HOME, '/srv/from-env');
    assert.equal(fromEnv.AMIRO_RUNTIME_HOME, '/srv/from-env');
  });
});

test('configuredRuntimeHome separates "configured" from "default"', () => {
  withEnv({}, () => {
    assert.equal(configuredRuntimeHome(), '');
    assert.equal(configuredRuntimeHome('/explicit'), '/explicit');
  });
  withEnv({ JCODE_HOME: '/a' }, () => assert.equal(configuredRuntimeHome(), '/a'));
  withEnv({ JCODE_HOME: '/a', AMIRO_JCODE_HOME: '/b' }, () => assert.equal(configuredRuntimeHome(), '/b'));
  withEnv({ JCODE_HOME: '/a', AMIRO_JCODE_HOME: '/b', AMIRO_RUNTIME_HOME: '/c' }, () =>
    assert.equal(configuredRuntimeHome(), '/c'),
  );
});

test('the credential directory mirrors the engine rule', () => {
  withEnv({ XDG_CONFIG_HOME: '/xdg' }, () => {
    assert.equal(resolveRuntimeConfigDir(''), path.join('/xdg', 'jcode'));
    assert.equal(resolveRuntimeConfigDir('/srv/home'), path.join('/srv/home', 'config', 'jcode'));
  });
  withEnv({}, () => {
    assert.equal(resolveRuntimeConfigDir(''), path.join(os.homedir(), '.config', 'jcode'));
  });
});

test('an explicit runtime binary always wins', () => {
  withEnv({}, () => {
    assert.equal(resolveRuntimeBin('/opt/engine'), '/opt/engine');
  });
  withEnv({ AMIRO_RUNTIME_BIN: '/opt/from-env' }, () => {
    assert.equal(resolveRuntimeBin(), '/opt/from-env');
    assert.deepEqual(describeRuntimeCli(), { bin: '/opt/from-env', kind: 'explicit' });
  });
});

test('unconfigured, the repo CLI shim is what the adapter drives', () => {
  withEnv({}, () => {
    const described = describeRuntimeCli();
    assert.equal(described.kind, 'repo-cli');
    assert.match(described.bin, /bin[/\\]amiro$/);
    assert.equal(resolveRuntimeBin(), described.bin);
  });
});
