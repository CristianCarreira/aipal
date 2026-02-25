const assert = require('node:assert/strict');
const test = require('node:test');

const { createTokenTracker, THRESHOLDS } = require('../src/token-tracker');

test('trackUsage accumulates tokens correctly', async () => {
  const tracker = createTokenTracker({ budgetDaily: 0 });

  await tracker.trackUsage({ chatId: '100', inputTokens: 50, outputTokens: 30 });
  await tracker.trackUsage({ chatId: '100', inputTokens: 20, outputTokens: 10 });

  const stats = tracker.getUsageStats('100');
  assert.equal(stats.totalTokens, 110);
  assert.equal(stats.totalInput, 70);
  assert.equal(stats.totalOutput, 40);
  assert.equal(stats.totalMessages, 2);
  assert.equal(stats.chat.tokens, 110);
  assert.equal(stats.chat.messages, 2);
});

test('trackUsage accumulates across multiple chats', async () => {
  const tracker = createTokenTracker({ budgetDaily: 0 });

  await tracker.trackUsage({ chatId: '100', inputTokens: 50, outputTokens: 30 });
  await tracker.trackUsage({ chatId: '200', inputTokens: 40, outputTokens: 20 });

  const stats = tracker.getUsageStats();
  assert.equal(stats.totalTokens, 140);
  assert.equal(stats.totalMessages, 2);
  assert.equal(stats.chat, undefined);

  const stats100 = tracker.getUsageStats('100');
  assert.equal(stats100.chat.tokens, 80);
  assert.equal(stats100.chat.messages, 1);
});

test('resets when day changes', async () => {
  const tracker = createTokenTracker({ budgetDaily: 0 });
  await tracker.trackUsage({ chatId: '100', inputTokens: 100, outputTokens: 50 });

  // Simulate loading state from a previous day
  await tracker.hydrate();
  // Force a day change by hydrating with a stale date
  const staleState = {
    date: '2020-01-01',
    chats: { '100': { input: 999, output: 999, messages: 99 } },
    alertsSent: [25, 50],
  };

  const tracker2 = createTokenTracker({
    budgetDaily: 0,
    loadUsage: async () => staleState,
  });
  await tracker2.hydrate();

  // After hydrate with a stale date, ensureToday should reset on next access
  const stats = tracker2.getUsageStats();
  assert.equal(stats.totalTokens, 0);
  assert.equal(stats.totalMessages, 0);
  assert.deepEqual(stats.alertsSent, []);
});

test('sends alerts once per threshold', async () => {
  const alerts = [];
  const tracker = createTokenTracker({
    budgetDaily: 1000,
    sendAlert: async (info) => {
      alerts.push(info.threshold);
    },
  });

  // Push to 30% — should trigger 25%
  await tracker.trackUsage({ chatId: '100', inputTokens: 200, outputTokens: 100 });
  assert.deepEqual(alerts, [25]);

  // Push to 55% — should trigger 50%
  await tracker.trackUsage({ chatId: '100', inputTokens: 150, outputTokens: 100 });
  assert.deepEqual(alerts, [25, 50]);

  // Push to 55% again with no new threshold — no new alert
  await tracker.trackUsage({ chatId: '100', inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(alerts, [25, 50]);

  // Push to 80% — should trigger 75%
  await tracker.trackUsage({ chatId: '100', inputTokens: 150, outputTokens: 100 });
  assert.deepEqual(alerts, [25, 50, 75]);

  // Push to 90% — should trigger 85%
  await tracker.trackUsage({ chatId: '100', inputTokens: 50, outputTokens: 50 });
  assert.deepEqual(alerts, [25, 50, 75, 85]);

  // Push to 100% — should trigger 95%
  await tracker.trackUsage({ chatId: '100', inputTokens: 50, outputTokens: 50 });
  assert.deepEqual(alerts, [25, 50, 75, 85, 95]);

  // Call again — no duplicates
  await tracker.trackUsage({ chatId: '100', inputTokens: 50, outputTokens: 50 });
  assert.deepEqual(alerts, [25, 50, 75, 85, 95]);
});

test('no alerts when budget is 0', async () => {
  const alerts = [];
  const tracker = createTokenTracker({
    budgetDaily: 0,
    sendAlert: async (info) => {
      alerts.push(info.threshold);
    },
  });

  await tracker.trackUsage({ chatId: '100', inputTokens: 50000, outputTokens: 50000 });
  assert.deepEqual(alerts, []);
});

test('getUsageStats returns correct format', async () => {
  const tracker = createTokenTracker({ budgetDaily: 10000 });

  await tracker.trackUsage({ chatId: '100', inputTokens: 500, outputTokens: 250 });

  const stats = tracker.getUsageStats('100');
  assert.equal(typeof stats.date, 'string');
  assert.match(stats.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(stats.totalTokens, 750);
  assert.equal(stats.totalInput, 500);
  assert.equal(stats.totalOutput, 250);
  assert.equal(stats.totalMessages, 1);
  assert.equal(stats.budgetDaily, 10000);
  assert.equal(stats.pct, 7.5);
  assert.ok(Array.isArray(stats.alertsSent));
  assert.ok(stats.chat);
  assert.equal(stats.chat.tokens, 750);
});

test('getUsageStats returns null pct when no budget', async () => {
  const tracker = createTokenTracker({ budgetDaily: 0 });
  await tracker.trackUsage({ chatId: '100', inputTokens: 100, outputTokens: 50 });

  const stats = tracker.getUsageStats();
  assert.equal(stats.pct, null);
});

test('resetUsage clears all state', async () => {
  const persisted = [];
  const tracker = createTokenTracker({
    budgetDaily: 1000,
    persistUsage: async (state) => {
      persisted.push(state);
    },
  });

  await tracker.trackUsage({ chatId: '100', inputTokens: 500, outputTokens: 250 });
  assert.equal(tracker.getUsageStats().totalTokens, 750);

  tracker.resetUsage();

  const stats = tracker.getUsageStats();
  assert.equal(stats.totalTokens, 0);
  assert.equal(stats.totalMessages, 0);
  assert.deepEqual(stats.alertsSent, []);
});

test('persistUsage is called after each trackUsage', async () => {
  let callCount = 0;
  const tracker = createTokenTracker({
    budgetDaily: 0,
    persistUsage: async () => {
      callCount++;
    },
  });

  await tracker.trackUsage({ chatId: '100', inputTokens: 10, outputTokens: 5 });
  assert.equal(callCount, 1);

  await tracker.trackUsage({ chatId: '100', inputTokens: 10, outputTokens: 5 });
  assert.equal(callCount, 2);
});

test('hydrate loads saved state for current day', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const savedState = {
    date: today,
    chats: { '100': { input: 200, output: 100, messages: 3 } },
    alertsSent: [25],
  };

  const tracker = createTokenTracker({
    budgetDaily: 1000,
    loadUsage: async () => savedState,
  });

  await tracker.hydrate();

  const stats = tracker.getUsageStats('100');
  assert.equal(stats.totalTokens, 300);
  assert.equal(stats.totalMessages, 3);
  assert.deepEqual(stats.alertsSent, [25]);
  assert.equal(stats.chat.tokens, 300);
});

test('THRESHOLDS contains expected values', () => {
  assert.deepEqual(THRESHOLDS, [25, 50, 75, 85, 95]);
});

test('trackUsage tracks by source', async () => {
  const tracker = createTokenTracker({ budgetDaily: 0 });

  await tracker.trackUsage({ chatId: '100', inputTokens: 50, outputTokens: 30, source: 'chat' });
  await tracker.trackUsage({ chatId: '100', inputTokens: 0, outputTokens: 20, source: 'chat' });
  await tracker.trackUsage({ chatId: '100', inputTokens: 40, outputTokens: 0, source: 'cron' });
  await tracker.trackUsage({ chatId: '100', inputTokens: 0, outputTokens: 60, source: 'cron' });

  const stats = tracker.getUsageStats();
  assert.equal(stats.totalTokens, 200);
  // messages only counted when inputTokens > 0
  assert.equal(stats.totalMessages, 2);

  assert.ok(stats.sources.chat);
  assert.equal(stats.sources.chat.tokens, 100);
  assert.equal(stats.sources.chat.messages, 1);

  assert.ok(stats.sources.cron);
  assert.equal(stats.sources.cron.tokens, 100);
  assert.equal(stats.sources.cron.messages, 1);
});

test('two-phase tracking counts messages only on input phase', async () => {
  const tracker = createTokenTracker({ budgetDaily: 0 });

  // Phase 1: input tokens (before agent runs)
  await tracker.trackUsage({ chatId: '100', inputTokens: 100, outputTokens: 0, source: 'chat' });
  // Phase 2: output tokens (after agent finishes)
  await tracker.trackUsage({ chatId: '100', inputTokens: 0, outputTokens: 50, source: 'chat' });

  const stats = tracker.getUsageStats('100');
  assert.equal(stats.totalTokens, 150);
  assert.equal(stats.totalMessages, 1, 'Only one message despite two trackUsage calls');
  assert.equal(stats.chat.messages, 1);
  assert.equal(stats.sources.chat.messages, 1);
});

test('isBudgetExhausted returns true when budget exceeded', async () => {
  const tracker = createTokenTracker({ budgetDaily: 1000 });

  assert.equal(tracker.isBudgetExhausted(), false);

  await tracker.trackUsage({ chatId: '100', inputTokens: 500, outputTokens: 499 });
  assert.equal(tracker.isBudgetExhausted(), false);

  await tracker.trackUsage({ chatId: '100', inputTokens: 1, outputTokens: 0 });
  assert.equal(tracker.isBudgetExhausted(), true);
});

test('isBudgetExhausted returns false when no budget', async () => {
  const tracker = createTokenTracker({ budgetDaily: 0 });
  await tracker.trackUsage({ chatId: '100', inputTokens: 999999, outputTokens: 999999 });
  assert.equal(tracker.isBudgetExhausted(), false);
});

test('getBudgetPct returns current percentage', async () => {
  const tracker = createTokenTracker({ budgetDaily: 1000 });

  assert.equal(tracker.getBudgetPct(), 0);

  await tracker.trackUsage({ chatId: '100', inputTokens: 250, outputTokens: 0 });
  assert.equal(tracker.getBudgetPct(), 25);

  await tracker.trackUsage({ chatId: '100', inputTokens: 250, outputTokens: 0 });
  assert.equal(tracker.getBudgetPct(), 50);
});

test('getBudgetPct returns null when no budget', () => {
  const tracker = createTokenTracker({ budgetDaily: 0 });
  assert.equal(tracker.getBudgetPct(), null);
});

test('hydrate loads sources from saved state', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const savedState = {
    date: today,
    chats: { '100': { input: 200, output: 100, messages: 3 } },
    sources: { cron: { input: 150, output: 80, messages: 2 }, chat: { input: 50, output: 20, messages: 1 } },
    alertsSent: [25],
  };

  const tracker = createTokenTracker({
    budgetDaily: 1000,
    loadUsage: async () => savedState,
  });

  await tracker.hydrate();

  const stats = tracker.getUsageStats();
  assert.equal(stats.sources.cron.tokens, 230);
  assert.equal(stats.sources.cron.messages, 2);
  assert.equal(stats.sources.chat.tokens, 70);
  assert.equal(stats.sources.chat.messages, 1);
});
