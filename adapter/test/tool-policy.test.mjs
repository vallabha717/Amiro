// adapter/test/tool-policy.test.mjs -- the tool-policy contract.
//
// Regression origin: the preview bridge withholds the `session_tools`
// capability for several seconds after a turn connection closes (measured
// ~2.7s). Capabilities are negotiated per connection in the `hello` handshake,
// so every follow-up message -- which necessarily opens a new connection --
// was told "This harness does not support session_tools" and the adapter
// aborted the turn. In the browser that looked like a chat that silently
// refused to answer the second question; a real user could not continue any
// conversation.
//
// The fix is at connect time: withIsolated opens its connection once the
// bridge advertises the capability again. These tests cover the waiting, the
// fail-closed give-up, and the policy value; the live behaviour is covered by
// adapter/test/browser-smoke.mjs and adapter/test/agent-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAmiroRuntime } from '../src/runtime.mjs';

process.env.AMIRO_TRUSTED_OPERATOR = '';
process.env.AMIRO_TOOL_PROFILE = 'none';

const { applyToolProfile, isSessionToolsWithheld, toolsOption } = await import('../src/chat.mjs');

const WITHHELD = 'unsupported: This harness does not support session_tools. Update the amiro runtime and API bridge.';
const DELAYS = [0, 200, 400, 700];

const manager = createAmiroRuntime({
  socketPath: '/nonexistent-test-socket',
  runtimeHome: '/nonexistent-test-home',
  binary: 'amiro',
  log: () => {},
});

function candidate(capabilities) {
  return {
    capabilities,
    supports: (capability) => capabilities.includes(capability),
    closed: false,
    async close() {
      this.closed = true;
    },
  };
}

function connector(capabilitySets) {
  const created = [];
  const sleeps = [];
  let index = 0;
  return {
    created,
    sleeps,
    connect: async () => {
      const set = capabilitySets[Math.min(index, capabilitySets.length - 1)];
      index += 1;
      const c = candidate(set);
      created.push(c);
      return c;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

function harness(capabilitySets) {
  const spy = connector(capabilitySets);
  const waits = [];
  return {
    spy,
    waits,
    options: {
      retryDelaysMs: DELAYS,
      sleep: spy.sleep,
      onWait: (info) => waits.push(info),
    },
  };
}

test('uses the first connection when the runtime advertises session_tools', async () => {
  const { spy, options, waits } = harness([['sessions', 'session_tools']]);
  const client = await manager.connectWithCapability(spy.connect, 'session_tools', options);
  assert.equal(spy.created.length, 1);
  assert.equal(client, spy.created[0]);
  assert.deepEqual(spy.sleeps, []);
  assert.deepEqual(waits, []);
  assert.equal(client.closed, false);
});

test('waits for the withholding window and keeps the capable connection', async () => {
  const { spy, options, waits } = harness([
    ['sessions'],
    ['sessions'],
    ['sessions', 'session_tools'],
  ]);
  const client = await manager.connectWithCapability(spy.connect, 'session_tools', options);
  assert.equal(spy.created.length, 3);
  assert.equal(client, spy.created[2]);
  // The two incapable connections are closed, so no socket/handle is leaked.
  assert.equal(spy.created[0].closed, true);
  assert.equal(spy.created[1].closed, true);
  assert.equal(client.closed, false);
  assert.deepEqual(spy.sleeps, [200, 400]);
  assert.deepEqual(waits, [{ capability: 'session_tools', attempts: 3, waitedMs: 600 }]);
});

test('accepts a client that cannot report capabilities at all', async () => {
  const legacy = { closed: false, async close() { this.closed = true; } };
  const client = await manager.connectWithCapability(async () => legacy, 'session_tools');
  assert.equal(client, legacy);
});

test('gives up after the bounded schedule instead of hanging forever', async () => {
  const { spy, options } = harness([['sessions']]);
  await assert.rejects(
    () => manager.connectWithCapability(spy.connect, 'session_tools', options),
    /did not advertise the session_tools capability after 4 connections/,
  );
  assert.equal(spy.created.length, DELAYS.length);
  assert.equal(spy.created.every((c) => c.closed), true);
  assert.deepEqual(spy.sleeps, [200, 400, 700]);
});

test('the public preview asks for no tools at all', () => {
  assert.deepEqual(toolsOption(), { enabled: [] });
});

test('applyToolProfile sends the policy and fails closed with no retry loop', async () => {
  const calls = [];
  const healthy = {
    async configureTools(sessionId, options) {
      calls.push({ sessionId, options });
    },
  };
  assert.equal(await applyToolProfile(healthy, 'session_a'), true);
  assert.deepEqual(calls, [{ sessionId: 'session_a', options: { enabled: [] } }]);

  let attempts = 0;
  const withheld = {
    async configureTools() {
      attempts += 1;
      throw new Error(WITHHELD);
    },
  };
  await assert.rejects(() => applyToolProfile(withheld, 'session_b'), /session_tools/);
  assert.equal(attempts, 1, 'the capability cannot appear on an open connection, so retrying it is pointless');
});

test('classifies the runtime message and nothing else', () => {
  assert.equal(isSessionToolsWithheld(new Error(WITHHELD)), true);
  assert.equal(isSessionToolsWithheld({ message: WITHHELD }), true);
  assert.equal(isSessionToolsWithheld(new Error('A tool configuration request is already in flight for this session')), false);
  assert.equal(isSessionToolsWithheld(new Error('unknown_session')), false);
  assert.equal(isSessionToolsWithheld(undefined), false);
});
