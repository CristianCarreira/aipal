const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadCronScheduler(configHome) {
  process.env.XDG_CONFIG_HOME = configHome;
  const configStorePath = path.join(__dirname, '..', 'src', 'config-store.js');
  const modulePath = path.join(__dirname, '..', 'src', 'cron-scheduler.js');
  delete require.cache[require.resolve(configStorePath)];
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test('loadCronJobs returns empty list when file is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { loadCronJobs } = loadCronScheduler(dir);
  const jobs = await loadCronJobs();
  assert.deepEqual(jobs, []);
});

test('saveCronJobs writes and loadCronJobs reads jobs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { loadCronJobs, saveCronJobs, CRON_PATH } = loadCronScheduler(dir);

  const input = [
    { id: 'test', cron: '* * * * *', prompt: 'hi', enabled: true },
    { id: 'off', cron: '0 0 * * *', prompt: 'nope', enabled: false },
  ];
  await saveCronJobs(input);

  const loaded = await loadCronJobs();
  assert.deepEqual(loaded, input);

  const raw = await fs.readFile(CRON_PATH, 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: input });
});

test('scheduleJobs passes topicId and job chatId to onTrigger', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { saveCronJobs, startCronScheduler } = loadCronScheduler(dir);

  const jobs = [
    {
      id: 'with-topic',
      cron: '* * * * *',
      prompt: 'hello',
      enabled: true,
      topicId: 99999,
      chatId: -100555,
    },
    {
      id: 'no-topic',
      cron: '* * * * *',
      prompt: 'world',
      enabled: true,
    },
  ];
  await saveCronJobs(jobs);

  const calls = [];
  const scheduler = startCronScheduler({
    chatId: -100111,
    onTrigger: async (chatId, prompt, options) => {
      calls.push({ chatId, prompt, options });
    },
  });

  // Wait for scheduleJobs to finish
  await new Promise((r) => setTimeout(r, 100));

  // Verify tasks were scheduled
  assert.equal(scheduler.tasks.size, 2);

  scheduler.stop();
});

test('saveCronJobs preserves topicId and chatId fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { loadCronJobs, saveCronJobs } = loadCronScheduler(dir);

  const input = [
    {
      id: 'newsletter',
      cron: '15 9 * * 4',
      prompt: 'gen newsletter',
      enabled: true,
      topicId: 12345,
      chatId: -100999,
    },
  ];
  await saveCronJobs(input);

  const loaded = await loadCronJobs();
  assert.equal(loaded[0].topicId, 12345);
  assert.equal(loaded[0].chatId, -100999);
});

test('buildCronTriggerPayload mirrors scheduler delivery fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-cron-'));
  const { buildCronTriggerPayload } = loadCronScheduler(dir);

  const payload = buildCronTriggerPayload(
    {
      id: 'nightly-interests',
      prompt: 'run now',
      topicId: 2801,
      chatId: -1003608686125,
      agent: 'codex',
    },
    123456
  );

  assert.deepEqual(payload, {
    chatId: -1003608686125,
    prompt: 'run now',
    options: {
      jobId: 'nightly-interests',
      agent: 'codex',
      topicId: 2801,
    },
  });
});
