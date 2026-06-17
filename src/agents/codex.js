const { shellQuote, resolvePromptValue } = require('./utils');

const CODEX_CMD = 'codex';
const BASE_ARGS = '--json --skip-git-repo-check --yolo';
const MODEL_ARG = '--model';
const REASONING_CONFIG_KEY = 'model_reasoning_effort';

function appendOptionalArg(args, flag, value) {
  if (!flag || !value) return args;
  return `${args} ${flag} ${shellQuote(value)}`.trim();
}

function appendOptionalReasoning(args, value) {
  if (!value) return args;
  const configValue = `${REASONING_CONFIG_KEY}="${value}"`;
  return `${args} --config ${shellQuote(configValue)}`.trim();
}

function buildCommand({ prompt, promptExpression, threadId, model, thinking }) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  let args = BASE_ARGS;
  args = appendOptionalArg(args, MODEL_ARG, model);
  args = appendOptionalReasoning(args, thinking);
  if (threadId) {
    return `${CODEX_CMD} exec resume ${shellQuote(threadId)} ${args} ${promptValue}`.trim();
  }
  return `${CODEX_CMD} exec ${args} ${promptValue}`.trim();
}

function extractErrorMessage(raw) {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    return extractErrorMessage(raw.message || raw.error || '');
  }
  const text = String(raw);
  // Codex nests the real error as a JSON string inside `message`.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const nested = extractErrorMessage(parsed.error || parsed.message);
      if (nested) return nested;
    } catch {
      /* fall through to the raw text */
    }
  }
  return text;
}

function parseOutput(output) {
  const lines = String(output || '').split(/\r?\n/);
  let threadId;
  const allMessages = [];
  const finalMessages = [];
  const errorMessages = [];
  let sawJson = false;
  let buffer = '';
  for (const line of lines) {
    if (!buffer) {
      if (!line.startsWith('{')) {
        continue;
      }
      buffer = line;
    } else {
      buffer += line;
    }
    let payload;
    try {
      payload = JSON.parse(buffer);
    } catch {
      continue;
    }
    sawJson = true;
    buffer = '';
    if (payload.type === 'thread.started' && payload.thread_id) {
      threadId = payload.thread_id;
      continue;
    }
    if (payload.type === 'error' || payload.type === 'turn.failed') {
      const msg = extractErrorMessage(payload.error || payload.message);
      if (msg && msg.trim()) errorMessages.push(msg.trim());
      continue;
    }
    if (payload.type === 'item.completed' && payload.item && typeof payload.item.text === 'string') {
      const itemType = String(payload.item.type || '');
      if (itemType.includes('message')) {
        const text = String(payload.item.text || '');
        if (!text.trim()) continue;
        allMessages.push(text);
        const channel = String(
          payload.item.channel ||
            payload.item.message?.channel ||
            payload.item.metadata?.channel ||
            ''
        ).toLowerCase();
        if (channel === 'final') {
          finalMessages.push(text);
        }
      }
    }
  }
  const selected = finalMessages.length > 0 ? finalMessages : allMessages.slice(-1);
  let text = selected.join('\n').trim();
  // No assistant message but the run errored: surface the error instead of an
  // empty string, so the cron handler can report it rather than silently drop it.
  if (!text && errorMessages.length > 0) {
    text = `⚠️ codex error: ${errorMessages[errorMessages.length - 1]}`;
  }
  return { text, threadId, sawJson };
}

module.exports = {
  id: 'codex',
  label: 'codex',
  needsPty: false,
  mergeStderr: false,
  buildCommand,
  parseOutput,
};
