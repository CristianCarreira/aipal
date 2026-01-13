const CODEX_CMD = 'codex';
const BASE_ARGS = '--json --skip-git-repo-check --yolo';
const MODEL_ARG = '--model';
const REASONING_CONFIG_KEY = 'model_reasoning_effort';

function shellQuote(value) {
  const escaped = String(value).replace(/'/g, String.raw`'\''`);
  return `'${escaped}'`;
}

function resolvePromptValue(prompt, promptExpression) {
  if (promptExpression) return promptExpression;
  return shellQuote(prompt);
}

function appendOptionalArg(args, flag, value) {
  if (!flag || !value) return args;
  return `${args} ${flag} ${shellQuote(value)}`.trim();
}

function appendOptionalReasoning(args, value) {
  if (!value) return args;
  const configValue = `${REASONING_CONFIG_KEY}="${value}"`;
  return `${args} --config ${shellQuote(configValue)}`.trim();
}

function buildAgentCommand(prompt, options = {}) {
  const { threadId, promptExpression, model, thinking } = options;
  const promptValue = resolvePromptValue(prompt, promptExpression);
  let args = BASE_ARGS;
  args = appendOptionalArg(args, MODEL_ARG, model);
  args = appendOptionalReasoning(args, thinking);
  if (threadId) {
    return `${CODEX_CMD} exec resume ${shellQuote(threadId)} ${args} ${promptValue}`.trim();
  }
  return `${CODEX_CMD} exec ${args} ${promptValue}`.trim();
}

function parseCodexJsonOutput(output) {
  const lines = output.split(/\r?\n/);
  let threadId;
  const messages = [];
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
    if (payload.type === 'item.completed' && payload.item && typeof payload.item.text === 'string') {
      const itemType = String(payload.item.type || '');
      if (itemType.includes('message')) {
        messages.push(payload.item.text);
      }
    }
  }
  const text = messages.join('\n').trim();
  return { text, threadId, sawJson };
}

function parseAgentOutput(output) {
  return parseCodexJsonOutput(output);
}

function getAgentLabel() {
  return 'codex';
}

module.exports = {
  buildAgentCommand,
  parseAgentOutput,
  getAgentLabel,
};
