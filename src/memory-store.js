const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CONFIG_DIR,
  MEMORY_PATH,
} = require('./config-store');
const {
  getMemoryIndexStatus,
  indexMemoryEvent,
} = require('./memory-index');

const MEMORY_DIR = path.join(CONFIG_DIR, 'memory');
const MEMORY_THREADS_DIR = path.join(MEMORY_DIR, 'threads');
const MEMORY_STATE_PATH = path.join(MEMORY_DIR, 'state.json');

const AUTO_MEMORY_START = '<!-- aipal:auto-memory:start -->';
const AUTO_MEMORY_END = '<!-- aipal:auto-memory:end -->';

const MAX_EVENT_TEXT_LENGTH = 2000;
const DEFAULT_CURATION_MAX_BYTES = 8192;
const DEFAULT_THREAD_BOOTSTRAP_LIMIT = 8;
const DEFAULT_TAIL_LIMIT = 10;
const DEFAULT_RECENT_ACTIVITY_LIMIT = 12;
const DEFAULT_MAX_EVENT_AGE_DAYS = 60;

const fileWriteQueues = new Map();

function normalizeText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function truncateText(input, maxLength = MAX_EVENT_TEXT_LENGTH) {
  const text = normalizeText(input);
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeIsoDate(value) {
  try {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function isoDay(value) {
  return safeIsoDate(value).slice(0, 10);
}

function toDisplayTime(value) {
  const date = new Date(safeIsoDate(value));
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeThreadKey(threadKey) {
  const raw = String(threadKey || 'unknown');
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'thread';
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 10);
  return `${slug}-${hash}.jsonl`;
}

function threadFilePath(threadKey) {
  return path.join(MEMORY_THREADS_DIR, normalizeThreadKey(threadKey));
}

function enqueueFileWrite(filePath, task) {
  const prev = fileWriteQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  fileWriteQueues.set(filePath, next);
  next.finally(() => {
    if (fileWriteQueues.get(filePath) === next) {
      fileWriteQueues.delete(filePath);
    }
  });
  return next;
}

function parseJsonl(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === 'object') {
        events.push(event);
      }
    } catch {
      // Ignore malformed lines and keep processing.
    }
  }
  return events;
}

async function listThreadFiles() {
  try {
    const entries = await fs.readdir(MEMORY_THREADS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(MEMORY_THREADS_DIR, entry.name));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readThreadEvents(threadKey) {
  const filePath = threadFilePath(threadKey);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseJsonl(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readAllThreadEvents(options = {}) {
  const maxAgeDays = Number.isFinite(options.maxAgeDays)
    ? options.maxAgeDays
    : DEFAULT_MAX_EVENT_AGE_DAYS;
  const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : null;
  const now = Date.now();
  const files = await listThreadFiles();
  const all = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const event of parseJsonl(raw)) {
      const createdAt = safeIsoDate(event.createdAt);
      if (maxAgeMs != null) {
        const ageMs = now - new Date(createdAt).getTime();
        if (ageMs > maxAgeMs) continue;
      }
      all.push({ ...event, createdAt });
    }
  }
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return all;
}

function scorePreference(text) {
  return /\b(prefiero|preferimos|por defecto|ll[aá]mame|siempre|nunca|evita|no uses?|usa)\b/i.test(
    text
  );
}

function scoreDecision(text) {
  return /\b(decidimos|vamos a|acordamos|adelante|implementa|hazlo|queda)\b/i.test(
    text
  );
}

function scoreProject(text) {
  return /\b(aipal|devexpert|ai expert|newsletter|youtube|linkedin|telegram|cron|agente)\b/i.test(
    text
  );
}

function normalizeDedupKey(text) {
  return normalizeText(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');
}

function pushUnique(target, seen, value) {
  const clean = normalizeText(value);
  if (!clean) return;
  const key = normalizeDedupKey(clean);
  if (!key || seen.has(key)) return;
  seen.add(key);
  target.push(clean);
}

function buildAutoMemorySection(events, options = {}) {
  const maxRecentActivity = Number.isFinite(options.maxRecentActivity)
    ? options.maxRecentActivity
    : DEFAULT_RECENT_ACTIVITY_LIMIT;

  const preferences = [];
  const decisions = [];
  const projects = [];
  const recentActivity = [];

  const seenPreferences = new Set();
  const seenDecisions = new Set();
  const seenProjects = new Set();

  for (const event of events) {
    const role = String(event.role || '');
    const text = truncateText(event.text, MAX_EVENT_TEXT_LENGTH);
    if (!text || role !== 'user') continue;
    if (scorePreference(text)) pushUnique(preferences, seenPreferences, text);
    if (scoreDecision(text)) pushUnique(decisions, seenDecisions, text);
    if (scoreProject(text)) pushUnique(projects, seenProjects, text);
  }

  const recent = events
    .slice()
    .reverse()
    .filter((event) => normalizeText(event.text))
    .slice(0, maxRecentActivity)
    .reverse();
  for (const event of recent) {
    const text = truncateText(event.text, 220);
    const topic = event.topicId ? `topic:${event.topicId}` : 'root';
    const who = event.role === 'assistant' ? 'assistant' : 'user';
    recentActivity.push(
      `- [${toDisplayTime(event.createdAt)}] (${who}, ${topic}) ${text}`
    );
  }

  const renderList = (items, fallback) =>
    items.length > 0
      ? items.map((item) => `- ${truncateText(item, 220)}`).join('\n')
      : `- ${fallback}`;

  return [
    '## Auto Memory (generated)',
    `_Updated: ${safeIsoDate()} · Source: memory/threads/*.jsonl_`,
    '',
    '### Preferencias detectadas',
    renderList(preferences.slice(-12), 'Sin señales todavía.'),
    '',
    '### Decisiones recientes',
    renderList(decisions.slice(-12), 'Sin señales todavía.'),
    '',
    '### Proyectos y foco',
    renderList(projects.slice(-12), 'Sin señales todavía.'),
    '',
    '### Actividad reciente',
    recentActivity.length > 0 ? recentActivity.join('\n') : '- Sin actividad reciente.',
  ].join('\n');
}

function stripAutoMemorySection(content) {
  const text = String(content || '');
  const pattern = new RegExp(
    `${escapeRegExp(AUTO_MEMORY_START)}[\\s\\S]*?${escapeRegExp(AUTO_MEMORY_END)}`,
    'g'
  );
  return text.replace(pattern, '').trim();
}

function formatMemoryContent(manualContent, autoSection) {
  const blocks = [];
  const manual = normalizeText(manualContent)
    ? String(manualContent).trim()
    : '';
  if (manual) blocks.push(manual);
  blocks.push(AUTO_MEMORY_START);
  blocks.push(autoSection.trim());
  blocks.push(AUTO_MEMORY_END);
  return `${blocks.join('\n\n')}\n`;
}

async function writeMemoryAtomically(content) {
  await fs.mkdir(path.dirname(MEMORY_PATH), { recursive: true });
  const tmpPath = `${MEMORY_PATH}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, MEMORY_PATH);
}

async function readMemoryState() {
  try {
    const raw = await fs.readFile(MEMORY_STATE_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    return {};
  }
}

async function writeMemoryState(state) {
  await fs.mkdir(path.dirname(MEMORY_STATE_PATH), { recursive: true });
  const tmpPath = `${MEMORY_STATE_PATH}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmpPath, MEMORY_STATE_PATH);
}

function trimAutoSectionToBudget(autoSection, budgetBytes) {
  const text = String(autoSection || '');
  if (Buffer.byteLength(text, 'utf8') <= budgetBytes) return text;
  if (budgetBytes <= 0) return '## Auto Memory (generated)\n- Omitido por límite de tamaño.';
  const trimmed = Buffer.from(text, 'utf8').subarray(0, budgetBytes - 1).toString('utf8');
  return `${trimmed}\n- (Auto memory recortada por tamaño.)`;
}

async function appendMemoryEvent(event) {
  const threadKey = String(event?.threadKey || '').trim();
  if (!threadKey) return;
  const text = truncateText(event?.text);
  if (!text) return;

  const entry = {
    id: randomUUID(),
    createdAt: safeIsoDate(event.createdAt),
    threadKey,
    chatId: String(event.chatId || ''),
    topicId: event.topicId == null ? '' : String(event.topicId),
    agentId: String(event.agentId || ''),
    role: event.role === 'assistant' ? 'assistant' : 'user',
    kind: String(event.kind || 'text'),
    text,
  };

  const filePath = threadFilePath(threadKey);
  await enqueueFileWrite(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  });
  try {
    await indexMemoryEvent(entry);
  } catch (err) {
    console.warn('Failed to index memory event:', err);
  }
}

async function buildThreadBootstrap(threadKey, options = {}) {
  const limit = Number.isFinite(options.limit)
    ? options.limit
    : DEFAULT_THREAD_BOOTSTRAP_LIMIT;
  const events = await readThreadEvents(threadKey);
  if (!events.length) return '';
  const recent = events.slice(-Math.max(1, limit));
  const lines = ['Recent thread memory:'];
  for (const event of recent) {
    const who = event.role === 'assistant' ? 'assistant' : 'user';
    lines.push(`- [${toDisplayTime(event.createdAt)}] ${who}: ${truncateText(event.text, 180)}`);
  }
  return lines.join('\n');
}

async function curateMemory(options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? options.maxBytes
    : DEFAULT_CURATION_MAX_BYTES;
  const events = await readAllThreadEvents({
    maxAgeDays: options.maxAgeDays,
  });

  let currentMemory = '';
  try {
    currentMemory = await fs.readFile(MEMORY_PATH, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  const manualContent = stripAutoMemorySection(currentMemory);
  const baseAuto = buildAutoMemorySection(events, {
    maxRecentActivity: options.maxRecentActivity,
  });
  const overhead = Buffer.byteLength(
    `${AUTO_MEMORY_START}\n\n${AUTO_MEMORY_END}\n\n`,
    'utf8'
  );
  const manualBytes = Buffer.byteLength(manualContent, 'utf8');
  const budgetBytes = Math.max(256, maxBytes - manualBytes - overhead);
  const autoSection = trimAutoSectionToBudget(baseAuto, budgetBytes);
  const nextContent = formatMemoryContent(manualContent, autoSection);

  await writeMemoryAtomically(nextContent);
  const state = {
    lastCuratedAt: safeIsoDate(),
    eventsProcessed: events.length,
    threadFiles: (await listThreadFiles()).length,
    maxBytes,
  };
  await writeMemoryState(state);

  return {
    memoryPath: MEMORY_PATH,
    eventsProcessed: events.length,
    threadFiles: state.threadFiles,
    lastCuratedAt: state.lastCuratedAt,
    bytes: Buffer.byteLength(nextContent, 'utf8'),
  };
}

async function getMemoryStatus(options = {}) {
  const files = await listThreadFiles();
  const events = await readAllThreadEvents({
    maxAgeDays: options.maxAgeDays || 0,
  });
  const state = await readMemoryState();
  let indexStatus = null;
  try {
    indexStatus = await getMemoryIndexStatus();
  } catch (err) {
    console.warn('Failed to read memory index status:', err);
  }
  const today = isoDay(new Date());
  const eventsToday = events.filter((event) => isoDay(event.createdAt) === today).length;
  return {
    memoryPath: MEMORY_PATH,
    threadsDir: MEMORY_THREADS_DIR,
    threadFiles: files.length,
    totalEvents: events.length,
    eventsToday,
    lastCuratedAt: state.lastCuratedAt || '',
    indexPath: indexStatus?.indexPath || '',
    indexedEvents: Number(indexStatus?.totalEvents || 0),
    indexSupportsFts: Boolean(indexStatus?.supportsFts),
  };
}

async function getThreadTail(threadKey, options = {}) {
  const limit = Number.isFinite(options.limit)
    ? options.limit
    : DEFAULT_TAIL_LIMIT;
  const events = await readThreadEvents(threadKey);
  return events.slice(-Math.max(1, limit));
}

module.exports = {
  AUTO_MEMORY_END,
  AUTO_MEMORY_START,
  MEMORY_DIR,
  MEMORY_STATE_PATH,
  MEMORY_THREADS_DIR,
  appendMemoryEvent,
  buildThreadBootstrap,
  curateMemory,
  getMemoryStatus,
  getThreadTail,
  normalizeThreadKey,
  stripAutoMemorySection,
  threadFilePath,
};
