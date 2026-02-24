const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createBackgroundTaskManager,
} = require('../src/services/background-tasks');

function createMockOptions(overrides = {}) {
  const sent = [];
  return {
    bot: {
      telegram: {
        sendChatAction: async () => {},
        sendMessage: async (chatId, text, extra) => {
          sent.push({ chatId, text, extra });
        },
      },
    },
    buildMemoryThreadKey: (chatId, topicId, agentId) =>
      `${chatId}:${topicId || 'none'}:${agentId || 'default'}`,
    captureMemoryEvent: async () => {},
    extractMemoryText: (r) => r,
    resolveEffectiveAgentId: () => 'codex',
    runAgentForChat: async () => 'agent response',
    sendResponseToChat: async () => {},
    sent,
    ...overrides,
  };
}

test('dispatch returns task info immediately', () => {
  const opts = createMockOptions();
  const mgr = createBackgroundTaskManager(opts);
  const task = mgr.dispatch(123, undefined, 'hello world');
  assert.equal(task.id, 1);
  assert.equal(task.status, 'running');
  assert.equal(task.chatId, 123);
  assert.equal(task.prompt, 'hello world');
  assert.ok(task.startedAt > 0);
});

test('dispatch increments task IDs', () => {
  const opts = createMockOptions();
  const mgr = createBackgroundTaskManager(opts);
  const t1 = mgr.dispatch(123, undefined, 'first');
  const t2 = mgr.dispatch(123, undefined, 'second');
  assert.equal(t1.id, 1);
  assert.equal(t2.id, 2);
});

test('task completes asynchronously and updates status', async () => {
  let resolveAgent;
  const agentPromise = new Promise((resolve) => {
    resolveAgent = resolve;
  });
  const opts = createMockOptions({
    runAgentForChat: () => agentPromise,
  });
  const mgr = createBackgroundTaskManager(opts);
  const task = mgr.dispatch(123, undefined, 'do something');
  assert.equal(task.status, 'running');

  resolveAgent('done!');
  await mgr.getPendingPromises()[0];

  assert.equal(task.status, 'completed');
  assert.ok(task.finishedAt > 0);
});

test('task failure updates status and sends error message', async () => {
  const opts = createMockOptions({
    runAgentForChat: async () => {
      throw new Error('agent crashed');
    },
  });
  const mgr = createBackgroundTaskManager(opts);
  const task = mgr.dispatch(123, undefined, 'fail task');

  await mgr.getPendingPromises()[0];

  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'agent crashed');
  assert.ok(opts.sent.some((m) => m.text.includes('failed')));
});

test('getStatus returns tasks for a specific chat', () => {
  const opts = createMockOptions();
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(100, undefined, 'chat 100 task');
  mgr.dispatch(200, undefined, 'chat 200 task');
  mgr.dispatch(100, undefined, 'chat 100 task 2');

  const chat100 = mgr.getStatus(100);
  assert.equal(chat100.length, 2);
  assert.ok(chat100.every((t) => t.chatId === 100));

  const chat200 = mgr.getStatus(200);
  assert.equal(chat200.length, 1);
  assert.equal(chat200[0].chatId, 200);
});

test('getStatus filters by topicId', () => {
  const opts = createMockOptions();
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(100, 'topic-a', 'task a');
  mgr.dispatch(100, 'topic-b', 'task b');

  const topicA = mgr.getStatus(100, 'topic-a');
  assert.equal(topicA.length, 1);
  assert.equal(topicA[0].prompt, 'task a');
});

test('tasks for same threadKey are serialized', async () => {
  const order = [];
  const opts = createMockOptions({
    runAgentForChat: async (chatId, prompt) => {
      order.push(`start:${prompt}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${prompt}`);
      return 'ok';
    },
  });
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(123, undefined, 'first');
  mgr.dispatch(123, undefined, 'second');

  await Promise.all(mgr.getPendingPromises());

  assert.deepEqual(order, [
    'start:first',
    'end:first',
    'start:second',
    'end:second',
  ]);
});

test('tasks for different threadKeys run in parallel', async () => {
  const order = [];
  const opts = createMockOptions({
    buildMemoryThreadKey: (chatId, topicId) =>
      `${chatId}:${topicId || 'none'}:codex`,
    runAgentForChat: async (chatId, prompt) => {
      order.push(`start:${prompt}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${prompt}`);
      return 'ok';
    },
  });
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(100, undefined, 'chat-100');
  mgr.dispatch(200, undefined, 'chat-200');

  await Promise.all(mgr.getPendingPromises());

  // Both should start before either ends
  assert.equal(order[0], 'start:chat-100');
  assert.equal(order[1], 'start:chat-200');
});

test('cleanup removes old completed tasks', async () => {
  const opts = createMockOptions();
  const mgr = createBackgroundTaskManager(opts);
  const task = mgr.dispatch(123, undefined, 'old task');

  await Promise.all(mgr.getPendingPromises());
  assert.equal(task.status, 'completed');

  // Simulate old finishedAt
  task.finishedAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
  mgr.cleanup();

  const remaining = mgr.getStatus(123);
  assert.equal(remaining.length, 0);
});

test('cleanup keeps running tasks', async () => {
  let resolveRunning;
  const opts = createMockOptions({
    runAgentForChat: () => new Promise((r) => { resolveRunning = r; }),
  });
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(123, undefined, 'running task');

  // Wait a tick so the promise chain starts executing and runAgentForChat is called
  await new Promise((r) => setImmediate(r));

  mgr.cleanup();

  const remaining = mgr.getStatus(123);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].status, 'running');

  resolveRunning('done');
  await Promise.all(mgr.getPendingPromises());
});

test('getPendingPromises returns chain promises', async () => {
  const opts = createMockOptions();
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(123, undefined, 'task 1');

  const pending = mgr.getPendingPromises();
  assert.equal(pending.length, 1);

  await Promise.all(pending);
  // After settling, chains clean up
  await new Promise((r) => setImmediate(r));
  assert.equal(mgr.getPendingPromises().length, 0);
});

test('prompt is truncated to 80 chars in task info', () => {
  const opts = createMockOptions();
  const mgr = createBackgroundTaskManager(opts);
  const longPrompt = 'a'.repeat(200);
  const task = mgr.dispatch(123, undefined, longPrompt);
  assert.equal(task.prompt.length, 80);
});

test('captureMemoryEvent is called on completion', async () => {
  const captured = [];
  const opts = createMockOptions({
    captureMemoryEvent: async (event) => captured.push(event),
  });
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(123, undefined, 'test memory');

  await Promise.all(mgr.getPendingPromises());

  assert.ok(captured.length > 0);
  const assistantEvent = captured.find((e) => e.role === 'assistant');
  assert.ok(assistantEvent);
  assert.equal(assistantEvent.chatId, 123);
});

test('sendResponseToChat is called on completion', async () => {
  const responses = [];
  const opts = createMockOptions({
    sendResponseToChat: async (chatId, response, sendOpts) => {
      responses.push({ chatId, response, sendOpts });
    },
  });
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(123, 'topic-1', 'send response');

  await Promise.all(mgr.getPendingPromises());

  assert.equal(responses.length, 1);
  assert.equal(responses[0].chatId, 123);
  assert.deepEqual(responses[0].sendOpts, { topicId: 'topic-1' });
});

test('typing indicator is sent', async () => {
  const typingCalls = [];
  const opts = createMockOptions({
    bot: {
      telegram: {
        sendChatAction: async (chatId, action, extra) => {
          typingCalls.push({ chatId, action, extra });
        },
        sendMessage: async () => {},
      },
    },
  });
  const mgr = createBackgroundTaskManager(opts);
  mgr.dispatch(123, undefined, 'typing test');

  await Promise.all(mgr.getPendingPromises());

  assert.ok(typingCalls.length >= 1);
  assert.equal(typingCalls[0].action, 'typing');
});
