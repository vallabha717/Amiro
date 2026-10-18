import test from 'node:test';
import assert from 'node:assert/strict';

import { historyToMessages } from '../src/threads.mjs';

test('historyToMessages folds assistant and tool rows into single assistant turn with reasoning and tools', () => {
  const history = [
    { role: 'user', content: 'Calculate 2+2' },
    {
      role: 'assistant',
      content: '<thinking>\nI need to use calculator\n</thinking>\nRunning tool...',
    },
    {
      role: 'tool',
      content: JSON.stringify({ result: 4 }),
      tool_data: {
        id: 'calc-1',
        name: 'calculator',
        input: { expr: '2+2' },
      },
    },
    {
      role: 'assistant',
      content: 'The answer is 4.',
      response_stats: {
        input_tokens: 100,
        output_tokens: 50,
        duration_secs: 1.25,
      },
    },
  ];

  const messages = historyToMessages('t1', 's1', history);
  assert.equal(messages.length, 2);

  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].parts[0].text, 'Calculate 2+2');

  assert.equal(messages[1].id, 'msg_1_s1');
  assert.equal(messages[1].role, 'assistant');
  const parts = messages[1].parts;
  assert.equal(parts.length, 4);

  assert.deepEqual(parts[0], { type: 'reasoning', text: 'I need to use calculator' });
  assert.deepEqual(parts[1], { type: 'text', text: 'Running tool...' });
  assert.deepEqual(parts[2], {
    type: 'tool-calculator',
    toolCallId: 'calc-1',
    toolName: 'calculator',
    state: 'output-available',
    input: { expr: '2+2' },
    output: { result: 4 },
  });
  assert.deepEqual(parts[3], { type: 'text', text: 'The answer is 4.' });

  assert.deepEqual(messages[1].metadata, {
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
    durationMs: 1250,
  });
});

test('historyToMessages simple assistant turn preserves backward compatibility', () => {
  const history = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' },
  ];
  const messages = historyToMessages('t1', 's1', history);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].id, 'msg_1_s1');
  assert.equal(messages[1].role, 'assistant');
  assert.deepEqual(messages[1].parts, [{ type: 'text', text: 'Hello' }]);
});
