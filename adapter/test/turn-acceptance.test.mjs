// adapter/test/turn-acceptance.test.mjs -- how a user message is handed to the
// daemon.
//
// Regression origin: an immediate follow-up after a reply failed about one time
// in three with "internal: Session is busy". The daemon refuses a message while
// it is still finishing the previous turn, and it refuses BEFORE accepting, so
// nothing was ingested and re-sending is safe. These tests use a fake client and
// an injected sleep, so they are deterministic and instant; the live behaviour
// is covered by adapter/test/browser-smoke.mjs and agent-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginAgentUserTurn, isSessionBusy } from '../src/agent-context.mjs';

const BUSY = 'internal: Session is busy';

// An event stream that yields the scripted batches, one per call to events().
function fakeClient(batches) {
  const opened = [];
  const sent = [];
  return {
    opened,
    sent,
    events(sessionId) {
      const batch = batches[Math.min(opened.length, batches.length - 1)];
      opened.push(sessionId);
      let index = 0;
      let closed = false;
      const iterator = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (closed || index >= batch.length) return { done: true, value: undefined };
          const value = batch[index];
          index += 1;
          return { done: false, value };
        },
        async return() {
          closed = true;
          return { done: true, value: undefined };
        },
      };
      return Promise.resolve(iterator);
    },
    notify(frame) {
      sent.push(frame);
    },
  };
}

function spies() {
  const waits = [];
  const retries = [];
  return {
    waits,
    retries,
    options: {
      busyRetryDelaysMs: [10, 20],
      sleep: async (ms) => {
        waits.push(ms);
      },
      onBusyRetry: (info) => retries.push(info),
    },
  };
}

test('an accepted message streams without any retry', async () => {
  const client = fakeClient([[{ ev: 'message_accepted' }, { ev: 'text_delta', delta: 'hi' }]]);
  const spy = spies();
  const stream = await beginAgentUserTurn(client, 'session_a', 'hello', [], 'reminder', 1_000, spy.options);
  const seen = [];
  for await (const event of stream) seen.push(event.ev);
  assert.deepEqual(seen, ['text_delta']);
  assert.equal(client.opened.length, 1);
  assert.equal(client.sent.length, 1);
  assert.deepEqual(spy.waits, []);
  assert.deepEqual(spy.retries, []);
});

test('a busy refusal is re-sent instead of failing the user turn', async () => {
  const client = fakeClient([
    [{ ev: 'error', message: BUSY }],
    [{ ev: 'model_info' }, { ev: 'message_accepted' }, { ev: 'text_delta', delta: 'ok' }],
  ]);
  const spy = spies();
  const stream = await beginAgentUserTurn(client, 'session_b', 'hello again', [], 'reminder', 1_000, spy.options);
  const seen = [];
  for await (const event of stream) seen.push(event.ev);
  assert.deepEqual(seen, ['model_info', 'text_delta'], 'buffered events of the accepted attempt are kept');
  assert.equal(client.sent.length, 2, 'the message is sent once per attempt, never queued twice');
  assert.equal(client.sent[1].content, 'hello again');
  assert.equal(client.sent[1].system_reminder, 'reminder');
  assert.deepEqual(spy.waits, [10]);
  assert.deepEqual(spy.retries, [{ attempt: 1, delayMs: 10 }]);
});

test('gives up after the bounded schedule and reports the refusal', async () => {
  const client = fakeClient([[{ ev: 'error', message: BUSY }]]);
  const spy = spies();
  await assert.rejects(
    () => beginAgentUserTurn(client, 'session_c', 'hello', [], 'reminder', 1_000, spy.options),
    /Session is busy/,
  );
  assert.equal(client.sent.length, 3, 'one send plus two retries');
  assert.deepEqual(spy.waits, [10, 20]);
});

test('never retries a different refusal', async () => {
  const client = fakeClient([[{ ev: 'error', message: 'usage_limit_reached: The usage limit has been reached' }]]);
  const spy = spies();
  await assert.rejects(
    () => beginAgentUserTurn(client, 'session_d', 'hello', [], 'reminder', 1_000, spy.options),
    /usage_limit_reached/,
  );
  assert.equal(client.sent.length, 1);
  assert.deepEqual(spy.waits, []);
});

test('a stream that closes before acceptance is not retried', async () => {
  const client = fakeClient([[]]);
  const spy = spies();
  await assert.rejects(
    () => beginAgentUserTurn(client, 'session_e', 'hello', [], 'reminder', 1_000, spy.options),
    /closed before accepting/,
  );
  assert.equal(client.sent.length, 1);
  assert.deepEqual(spy.waits, []);
});

test('classifies only the busy refusal', () => {
  assert.equal(isSessionBusy(new Error(BUSY)), true);
  assert.equal(isSessionBusy({ message: 'Session is busy' }), true);
  assert.equal(isSessionBusy(new Error('usage_limit_reached: The usage limit has been reached')), false);
  assert.equal(isSessionBusy(new Error('does not support session_tools')), false);
  assert.equal(isSessionBusy(undefined), false);
});
