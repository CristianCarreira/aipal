const { resolvePromptValue } = require('./utils');

const GEMINI_CMD = 'gemini';
const GEMINI_OUTPUT_FORMAT = 'json';
const SESSION_ID_REGEX = /\[([0-9a-f-]{16,})\]/i;

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildCommand({ prompt, promptExpression, threadId, model }) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  const args = ['-p', promptValue, '--output-format', GEMINI_OUTPUT_FORMAT, '--yolo'];
  if (model) {
    args.push('--model', model);
  }
  if (threadId) {
    args.push('--resume', threadId);
  }
  return `${GEMINI_CMD} ${args.join(' ')}`.trim();
}

function parseOutput(output) {
  const trimmed = String(output || '').trim();
  if (!trimmed) return { text: '', threadId: undefined, sawJson: false };
  const payload = safeJsonParse(trimmed);
  if (!payload || typeof payload !== 'object') {
    return { text: trimmed, threadId: undefined, sawJson: false };
  }
  if (payload.error?.message) {
    return { text: String(payload.error.message), threadId: undefined, sawJson: true };
  }
  const response = typeof payload.response === 'string' ? payload.response.trim() : '';
  const threadId = typeof payload.session_id === 'string' && payload.session_id
    ? payload.session_id
    : undefined;

  let usage;
  if (payload.stats && typeof payload.stats === 'object' && payload.stats.models) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    for (const model of Object.values(payload.stats.models)) {
      if (model.tokens && typeof model.tokens === 'object') {
        inputTokens += Number(model.tokens.prompt) || 0;
        outputTokens += Number(model.tokens.candidates) || 0;
        cachedTokens += Number(model.tokens.cached) || 0;
      }
    }
    if (inputTokens > 0 || outputTokens > 0) {
      usage = { inputTokens, outputTokens, cachedTokens };
    }
  }

  return { text: response, threadId, sawJson: true, usage };
}

function listSessionsCommand() {
  return `${GEMINI_CMD} --list-sessions`;
}

function parseSessionList(output) {
  const lines = String(output || '').split(/\r?\n/);
  let lastId;
  for (const line of lines) {
    const match = line.match(SESSION_ID_REGEX);
    if (match) {
      lastId = match[1];
    }
  }
  return lastId;
}

module.exports = {
  id: 'gemini',
  label: 'gemini',
  needsPty: false,
  mergeStderr: false,
  buildCommand,
  parseOutput,
  listSessionsCommand,
  parseSessionList,
};
