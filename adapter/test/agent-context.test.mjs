import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beginAgentUserTurn } from '../src/agent-context.mjs';

function harness(frames, { failNotify = false } = {}) {
  let opened = false;
  let closed = false;
  let pending;
  const queue = [];
  const requests = [];
  const events = {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (closed) return Promise.resolve({ done: true });
      return new Promise((resolve) => { pending = resolve; });
    },
    return() { closed = true; pending?.({ done: true }); return Promise.resolve({ done: true }); },
    [Symbol.asyncIterator]() { return this; },
  };
  const client = {
    events() { opened = true; return events; },
    notify(request) {
      assert(opened, 'subscribe before notify');
      if (failNotify) throw new Error('socket closed');
      requests.push(request);
      for (const frame of frames) {
        if (pending) { const resolve = pending; pending = null; resolve({ value: frame, done: false }); }
        else queue.push(frame);
      }
    },
  };
  return { client, requests, get closed() { return closed; } };
}

test('one actual user frame carries hidden reminder and preserves streamed events', async () => {
  const h = harness([
    { ev: 'status', session_id: 's', status: 'ready' },
    { ev: 'message_accepted', session_id: 's' },
    { ev: 'text_delta', session_id: 's', text: 'Hello' },
    { ev: 'turn_done', session_id: 's' },
  ]);
  const iter = await beginAgentUserTurn(h.client, 's', 'Visible user question', [['image/png', 'abc']], 'Hidden persona');
  assert.equal(h.closed, false, 'acceptance must not close iterator');
  const got = [];
  for await (const event of iter) { got.push(event); if (event.ev === 'turn_done') break; }
  assert.deepEqual(got.map((event) => event.ev), ['status', 'text_delta', 'turn_done']);
  assert.equal(h.requests.length, 1, 'no empty auxiliary model turn');
  assert.deepEqual(h.requests[0], { req: 'send_message', session_id: 's', content: 'Visible user question', images: [['image/png', 'abc']], system_reminder: 'Hidden persona' });
  assert.equal(h.closed, true);
});

test('timeout closes the event subscription', async () => {
  const h = harness([]);
  await assert.rejects(beginAgentUserTurn(h.client, 's', 'question', [], 'persona', 15), /timed out/);
  assert.equal(h.closed, true);
});

test('protocol rejection is surfaced rather than waiting forever', async () => {
  const h = harness([{ ev: 'error', session_id: 's', message: 'refused' }]);
  await assert.rejects(beginAgentUserTurn(h.client, 's', 'question', [], 'persona'), /refused/);
  assert.equal(h.closed, true);
});

test('transport failure cleans subscription without an extra turn', async () => {
  const h = harness([], { failNotify: true });
  await assert.rejects(beginAgentUserTurn(h.client, 's', 'question', [], 'persona'), /socket closed/);
  assert.equal(h.closed, true);
  assert.equal(h.requests.length, 0);
});

test('another session cannot acknowledge this user turn', async () => {
  const h = harness([{ ev: 'message_accepted', session_id: 'other' }, { ev: 'message_accepted', session_id: 's' }, { ev: 'turn_done', session_id: 's' }]);
  const iter = await beginAgentUserTurn(h.client, 's', 'question', [], 'persona');
  for await (const event of iter) { assert.equal(event.session_id, 's'); break; }
});

test('chat never replaces the assembled native Jcode system prompt', async () => {
  const source = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert(!source.includes('systemPrompt:'), 'persona must not erase native system or memory');
  assert(source.includes('buildAgentTurnReminder(ctx, user'));
  assert(!source.includes('sendSystemReminder('), 'standalone reminders start an extra model turn');
});
