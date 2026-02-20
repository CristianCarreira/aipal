const assert = require('node:assert/strict');
const test = require('node:test');

const { createEnqueue } = require('../src/services/queue');

test('createEnqueue serializes jobs per key and cleans queue map', async () => {
  const queues = new Map();
  const enqueue = createEnqueue(queues);
  const order = [];

  const slow = () =>
    enqueue('chat:1', async () => {
      order.push('start-a');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('end-a');
    });

  const fast = () =>
    enqueue('chat:1', async () => {
      order.push('start-b');
      order.push('end-b');
    });

  await Promise.all([slow(), fast()]);

  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queues.has('chat:1'), false);
});
