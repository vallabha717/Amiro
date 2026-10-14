// adapter/src/usage.mjs -- usage and stats aggregation.
//
// Computes user usage stats from:
//   - jcode usage --json (quota limits & extra info)
//   - ~/.jcode/openai_oauth_usage.json (lifetime + daily token buckets & cost)
//   - ~/.jcode/model-usage-v1.sqlite3 turns table (modelStats & message counts)
//   - threads.json / listSessions (threadCount)

import path from 'node:path';

function formatPeriodDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export async function getUserStats(ctx, userId, query = {}) {
  const { days, from, to } = query;

  let startDate;
  let endDate = null;
  let period = 'Last 30 Days';

  if (from) {
    startDate = new Date(from);
    if (to) {
      endDate = new Date(to);
      period = `${formatPeriodDate(startDate)} - ${formatPeriodDate(endDate)}`;
    } else {
      period = `From ${formatPeriodDate(startDate)}`;
    }
  } else if (days != null && days !== '') {
    const d = Number(days);
    if (!Number.isFinite(d) || d < 1 || d > 3650) {
      const err = new Error('days must be between 1 and 3650'); err.status = 400; throw err;
    }
    if (d <= 1) {
      const now = new Date();
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
      period = 'Today';
    } else {
      startDate = new Date(Date.now() - d * 24 * 3600 * 1000);
      period = `Last ${d} Days`;
    }
  } else {
    startDate = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    period = 'Last 30 Days';
  }

  if (Number.isNaN(startDate.getTime()) || (endDate && Number.isNaN(endDate.getTime()))) {
    const err = new Error('Invalid usage date range'); err.status = 400; throw err;
  }
  startDate.setUTCHours(0, 0, 0, 0);
  if (endDate) endDate.setUTCHours(23, 59, 59, 999);
  const startMs = startDate.getTime();
  const endMs = endDate ? endDate.getTime() : Infinity;
  if (endMs < startMs) { const err = new Error('End date precedes start date'); err.status = 400; throw err; }

  // 1. Thread count from threads.json or listSessions
  let threadCount = 0;
  try {
    const threadsDoc = await ctx.store.readJson(path.join(ctx.config.home, 'threads.json'), {});
    const threadList = Object.values(threadsDoc);
    const userThreads = threadList.filter((t) => !userId || t.userId === userId);
    threadCount = userThreads.length;
  } catch {
    threadCount = 0;
  }
  // Never count unrelated sessions in the shared daemon as this user's threads.

  // 2. Turns from model-usage-v1.sqlite3
  let turns = [];
  try {
    turns = await ctx.jcode.readModelUsageTurns();
  } catch {
    turns = [];
  }

  const modelStatsMap = new Map();
  let turnsInRangeCount = 0;

  for (const turn of turns) {
    const turnMs = (turn.last_used || 0) * 1000;
    if (turnMs >= startMs && turnMs <= endMs) {
      turnsInRangeCount += 1;
      const key = `${turn.provider || 'unknown'}:${turn.model || 'unknown'}`;
      let stat = modelStatsMap.get(key);
      if (!stat) {
        stat = {
          model: turn.model || 'unknown',
          provider: turn.provider || 'unknown',
          messageCount: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalCost: 0,
        };
        modelStatsMap.set(key, stat);
      }
      stat.messageCount += 1;
    }
  }

  // 3. OAuth usage data (openai_oauth_usage.json)
  let oauthUsage = { accounts: {} };
  try {
    oauthUsage = await ctx.jcode.readOpenAiOauthUsage();
  } catch {
    oauthUsage = { accounts: {} };
  }

  const dailyUsageMap = new Map();
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCost = 0;
  let unpricedRequests = 0;

  const accounts = (oauthUsage && oauthUsage.accounts) || {};
  for (const acc of Object.values(accounts)) {
    const daysObj = acc.days || {};
    for (const [dateStr, dayData] of Object.entries(daysObj)) {
      const dayDate = new Date(`${dateStr}T00:00:00Z`);
      const dayMs = dayDate.getTime();
      if (dayMs >= startMs && dayMs <= endMs) {
        let entry = dailyUsageMap.get(dateStr);
        if (!entry) {
          entry = {
            date: dateStr,
            totalTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalCost: 0,
            messageCount: 0,
          };
          dailyUsageMap.set(dateStr, entry);
        }
        const inp = Number(dayData.input || 0);
        const out = Number(dayData.output || 0);
        const tok = inp + out;
        const cost = Number(dayData.known_usd || 0);
        const reqs = Number(dayData.requests || 0);

        entry.promptTokens += inp;
        entry.completionTokens += out;
        entry.totalTokens += tok;
        entry.totalCost += cost;
        entry.messageCount += reqs;

        totalPromptTokens += inp;
        totalCompletionTokens += out;
        totalTokens += tok;
        totalCost += cost;
        unpricedRequests += Number(dayData.unpriced_requests || 0);
      }
    }
  }

  // The SQLite table records model activity, not model tokens or billing.
  // Account-level OpenAI buckets cannot honestly be apportioned to models.
  const modelStats = [];
  const modelActivity = Array.from(modelStatsMap.values()).map(({ model, provider, messageCount }) => ({ model, provider, messageCount }));

  const dailyUsage = Array.from(dailyUsageMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // 4. Rate-limit quotas from jcode usage --json
  const limits = [];
  try {
    const usageJson = await ctx.jcode.jcodeUsage();
    if (usageJson && Array.isArray(usageJson.providers)) {
      for (const prov of usageJson.providers) {
        if (Array.isArray(prov.limits)) {
          for (const lim of prov.limits) {
            limits.push({
              name: lim.name,
              usage_percent: lim.usage_percent,
              resets_at: lim.resets_at,
              reset_in: lim.reset_in,
              provider: prov.provider_name,
            });
          }
        }
      }
    }
  } catch {
    // ignore
  }

  const messageCount = turnsInRangeCount || dailyUsage.reduce((sum, d) => sum + d.messageCount, 0);

  return {
    threadCount,
    messageCount,
    modelStats,
    totalTokens,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    totalCost: Number(totalCost.toFixed(4)),
    promptCost: 0,
    completionCost: 0,
    dailyUsage,
    period,
    limits,
    unpricedRequests,
    modelActivity,
    scope: 'shared-provider-account',
    tokenSource: 'OpenAI OAuth daily buckets only',
    perUserAttributionAvailable: false,
    perModelBillingAvailable: false,
    usageNotice: 'Usage is shared Jcode provider-account data, not per-user billing. Token and known-cost totals cover OpenAI OAuth only. Per-model token attribution is unavailable.',
  };
}
