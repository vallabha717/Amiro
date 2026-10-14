import test from 'node:test';
import assert from 'node:assert/strict';
import { getUserStats } from '../src/usage.mjs';

function context() {
  return {
    config: { home: '/unused' },
    store: { readJson: async () => ({ t1: { userId: 'one' }, t2: { userId: 'two' } }) },
    jcode: {
      readModelUsageTurns: async () => [
        { provider: 'OpenCode Go', model: 'deepseek-v4.1-flash', last_used: Date.parse('2026-10-14T12:00:00Z') / 1000 },
      ],
      readOpenAiOauthUsage: async () => ({ accounts: { owner: { days: {
        '2026-10-14': { input: 100, output: 20, requests: 2, known_usd: 0.012, unpriced_requests: 1 },
        '2026-10-13': { input: 500, output: 50, requests: 3, known_usd: 0.05 },
      } } } }),
      jcodeUsage: async () => ({ providers: [{ provider_name: 'OpenAI', limits: [
        { name: '5 hours', usage_percent: 40, resets_at: '2026-10-14T15:00:00Z', reset_in: '3 hours' },
      ] }] }),
    },
  };
}

test('account totals are exact and not fabricated per model or user', async () => {
  const stats = await getUserStats(context(), 'one', { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(stats.totalTokens, 120);
  assert.equal(stats.promptTokens, 100);
  assert.equal(stats.completionTokens, 20);
  assert.equal(stats.totalCost, 0.012);
  assert.equal(stats.threadCount, 1);
  assert.equal(stats.unpricedRequests, 1);
  assert.deepEqual(stats.modelStats, []);
  assert.equal(stats.modelActivity[0].provider, 'OpenCode Go');
  assert.equal(stats.perUserAttributionAvailable, false);
  assert.equal(stats.perModelBillingAvailable, false);
  assert.match(stats.usageNotice, /OpenAI OAuth only/);
  assert.equal(stats.limits[0].usage_percent, 40);
});

test('invalid ranges fail explicitly', async () => {
  for (const query of [{ days: 'NaN' }, { days: -1 }, { from: 'invalid' }, { from: '2026-10-15', to: '2026-10-14' }]) {
    await assert.rejects(getUserStats(context(), 'one', query), { status: 400 });
  }
});

test('null query parameters keep the default 30 day period', async () => {
  assert.equal((await getUserStats(context(), 'one', { days: null })).period, 'Last 30 Days');
});

test('empty user mapping does not count other shared daemon sessions', async () => {
  const ctx = context();
  ctx.store.readJson = async () => ({});
  ctx.jcode.api = { listSessions: () => { throw new Error('Must not inspect unrelated daemon sessions'); } };
  assert.equal((await getUserStats(ctx, 'one', { from: '2026-10-14' })).threadCount, 0);
});
