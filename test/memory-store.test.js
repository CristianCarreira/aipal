const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadModules(configHome) {
  process.env.XDG_CONFIG_HOME = configHome;
  const configStorePath = path.join(__dirname, '..', 'src', 'config-store.js');
  const memoryIndexPath = path.join(__dirname, '..', 'src', 'memory-index.js');
  const memoryStorePath = path.join(__dirname, '..', 'src', 'memory-store.js');
  delete require.cache[require.resolve(configStorePath)];
  delete require.cache[require.resolve(memoryIndexPath)];
  delete require.cache[require.resolve(memoryStorePath)];
  const configStore = require(configStorePath);
  const memoryStore = require(memoryStorePath);
  return { configStore, memoryStore };
}

test('appendMemoryEvent and getThreadTail persist per-thread history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-memory-'));
  const { memoryStore } = loadModules(dir);

  await memoryStore.appendMemoryEvent({
    threadKey: '123:root:codex',
    chatId: 123,
    topicId: '',
    agentId: 'codex',
    role: 'user',
    kind: 'text',
    text: 'hola',
  });
  await memoryStore.appendMemoryEvent({
    threadKey: '123:root:codex',
    chatId: 123,
    topicId: '',
    agentId: 'codex',
    role: 'assistant',
    kind: 'text',
    text: 'respuesta',
  });
  await memoryStore.appendMemoryEvent({
    threadKey: 'other:root:codex',
    chatId: 'other',
    topicId: '',
    agentId: 'codex',
    role: 'user',
    kind: 'text',
    text: 'otro hilo',
  });

  const tail = await memoryStore.getThreadTail('123:root:codex', { limit: 10 });
  assert.equal(tail.length, 2);
  assert.equal(tail[0].text, 'hola');
  assert.equal(tail[1].text, 'respuesta');
  assert.equal(tail[0].role, 'user');
  assert.equal(tail[1].role, 'assistant');
});

test('buildThreadBootstrap returns recent entries for a thread', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-memory-'));
  const { memoryStore } = loadModules(dir);

  await memoryStore.appendMemoryEvent({
    threadKey: 'chat:topic:codex',
    role: 'user',
    text: 'primer evento',
  });
  await memoryStore.appendMemoryEvent({
    threadKey: 'chat:topic:codex',
    role: 'assistant',
    text: 'segundo evento',
  });

  const bootstrap = await memoryStore.buildThreadBootstrap('chat:topic:codex', {
    limit: 1,
  });
  assert.match(bootstrap, /Recent thread memory:/);
  assert.match(bootstrap, /assistant: segundo evento/);
  assert.doesNotMatch(bootstrap, /primer evento/);
});

test('curateMemory appends auto section while preserving manual memory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-memory-'));
  const { configStore, memoryStore } = loadModules(dir);

  await fs.mkdir(path.dirname(configStore.MEMORY_PATH), { recursive: true });
  await fs.writeFile(
    configStore.MEMORY_PATH,
    '# Memoria manual\n\n- Llámame Nexo\n',
    'utf8'
  );

  await memoryStore.appendMemoryEvent({
    threadKey: 'chat:root:codex',
    chatId: 'chat',
    topicId: '',
    agentId: 'codex',
    role: 'user',
    text: 'Por defecto háblame en español.',
  });
  await memoryStore.appendMemoryEvent({
    threadKey: 'chat:root:codex',
    chatId: 'chat',
    topicId: '',
    agentId: 'codex',
    role: 'assistant',
    text: 'Entendido.',
  });

  const result = await memoryStore.curateMemory({ maxBytes: 12000 });
  assert.equal(result.memoryPath, configStore.MEMORY_PATH);
  assert.equal(result.eventsProcessed, 2);

  const content = await fs.readFile(configStore.MEMORY_PATH, 'utf8');
  assert.match(content, /# Memoria manual/);
  assert.match(content, /aipal:auto-memory:start/);
  assert.match(content, /Preferencias detectadas/);
});

test('getMemoryStatus summarizes stored events and curation state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-memory-'));
  const { memoryStore } = loadModules(dir);

  await memoryStore.appendMemoryEvent({
    threadKey: 'chat:root:codex',
    role: 'user',
    text: 'evento de hoy',
  });
  await memoryStore.curateMemory();

  const status = await memoryStore.getMemoryStatus();
  assert.equal(status.threadFiles, 1);
  assert.equal(status.totalEvents, 1);
  assert.equal(status.eventsToday, 1);
  assert.match(status.lastCuratedAt, /^\d{4}-\d{2}-\d{2}T/);
});
