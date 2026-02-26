const { shellQuote, resolvePromptValue } = require('./utils');

const CLAUDE_CMD = 'claude';
const CLAUDE_OUTPUT_FORMAT = 'json';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\x1B\[[0-9;:<=>?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '');
}

function buildCommand({ prompt, promptExpression, threadId, threadIdExpression, model }) {
  const promptValue = resolvePromptValue(prompt, promptExpression);
  const args = [
    '-p',
    promptValue,
    '--output-format',
    CLAUDE_OUTPUT_FORMAT,
    '--dangerously-skip-permissions',
  ];
  if (model) {
    args.push('--model', model);
  }
  if (threadId) {
    args.push('--resume', shellQuote(threadId));
  }
  return `${CLAUDE_CMD} ${args.join(' ')}`.trim();
}

function parseOutput(output) {
  const cleaned = stripAnsi(output);
  const trimmed = cleaned.trim();
  if (!trimmed) return { text: '', threadId: undefined, sawJson: false };
  let payload = safeJsonParse(trimmed);
  if (!payload) {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      payload = safeJsonParse(line.trim());
      if (payload) break;
    }
  }
  if (!payload || typeof payload !== 'object') {
    return { text: trimmed, threadId: undefined, sawJson: false };
  }
  const rawThreadId =
    payload.session_id ||
    payload.sessionId ||
    payload.conversation_id ||
    payload.conversationId ||
    undefined;
  const threadId =
    typeof rawThreadId === 'string' && UUID_REGEX.test(rawThreadId.trim())
      ? rawThreadId.trim()
      : undefined;
  let text = payload.result;
  if (typeof text !== 'string') {
    text = payload.text;
  }
  if (typeof text !== 'string') {
    text = payload.output;
  }
  if (typeof text !== 'string' && payload.structured_output != null) {
    text = JSON.stringify(payload.structured_output, null, 2);
  }

  let usage;
  if (payload.usage && typeof payload.usage === 'object') {
    const inputTokens = Number(payload.usage.input_tokens) || 0;
    const outputTokens = Number(payload.usage.output_tokens) || 0;
    const cacheCreationTokens = Number(payload.usage.cache_creation_input_tokens) || 0;
    const cacheReadTokens = Number(payload.usage.cache_read_input_tokens) || 0;
    usage = { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
  }
  const costUsd = typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : undefined;

  return { text: typeof text === 'string' ? text.trim() : '', threadId, sawJson: true, usage, costUsd };
}

module.exports = {
  id: 'claude',
  label: 'claude',
  needsPty: true,
  mergeStderr: false,
  buildCommand,
  parseOutput,
};
