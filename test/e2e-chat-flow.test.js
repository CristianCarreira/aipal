const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerTextHandler } = require('../src/handlers/text');
const {
  buildPrompt,
  chunkMarkdown,
  chunkText,
  formatError,
  markdownToTelegramHtml,
  parseSlashCommand,
} = require('../src/message-utils');
const { createEnqueue } = require('../src/services/queue');
const { createAgentRunner } = require('../src/services/agent-runner');
const { createTelegramReplyService } = require('../src/services/telegram-reply');
const { buildThreadKey, buildTopicKey, resolveThreadId } = require('../src/thread-store');

test('e2e: text handler runs bootstrap + agent + telegram reply with thread continuity', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-e2e-'));
  const imageDir = path.join(tmp, 'images');
  const documentDir = path.join(tmp, 'documents');
  await fs.mkdir(imageDir, { recursive: true });
  await fs.mkdir(documentDir, { recursive: true });

  const bot = {
    handlers: new Map(),
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    telegram: {
      sendChatAction: async () => {},
      sendMessage: async (_chatId, text) => { ackMessages.push(text); },
      sendPhoto: async () => {},
      sendDocument: async () => {},
    },
  };

  const queues = new Map();
  const enqueue = createEnqueue(queues);
  const agentWorkPromises = [];
  function trackAgentWork(work) {
    agentWorkPromises.push(work);
  }
  const threadTurns = new Map();
  const threads = new Map();
  const capturedEvents = [];
  const commandHistory = [];
  const promptHistory = [];
  const buildCalls = [];
  const sentResponses = [];
  const ackMessages = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      buildCalls.push(options);
      const thread = options.threadId || 'new';
      return `fake-agent --thread ${thread} --prompt ${options.promptExpression}`;
    },
    parseOutput(output) {
      let threadId;
      let text = '';
      let sawJson = false;
      for (const line of String(output || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          sawJson = true;
          if (data.type === 'thread.started') {
            threadId = data.thread_id;
          }
          if (data.type === 'item.completed' && data.item?.type === 'message') {
            text = data.item.text || text;
          }
        } catch {
          // Ignore non-json lines.
        }
      }
      return { text, threadId, sawJson };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async ({ threadKey }) => `BOOTSTRAP(${threadKey})`,
    buildMemoryRetrievalContext: async () => 'MEMORY_CONTEXT',
    buildPrompt,
    documentDir,
    execLocal: async (_cmd, args, options) => {
      const command = args[1];
      commandHistory.push(command);
      promptHistory.push((options && options.env && options.env.AIPAL_PROMPT) || '');
      if (command.includes('--thread new')) {
        return [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'message', text: 'Primera respuesta' },
          }),
        ].join('\n');
      }

      return JSON.stringify({
        type: 'item.completed',
        item: { type: 'message', text: 'Segunda respuesta' },
      });
    },
    fileInstructionsEvery: 3,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake Agent',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir,
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (value) => value,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadTurns,
    wrapCommandWithPty: (value) => value,
    defaultTimeZone: 'UTC',
  });

  const captureMemoryEvent = async (event) => {
    capturedEvents.push(event);
  };
  const extractMemoryText = (value) => String(value || '');
  const resolveEffectiveAgentId = () => 'fake';

  registerTextHandler({
    bot,
    buildMemoryThreadKey: buildThreadKey,
    buildTopicKey,
    captureMemoryEvent,
    consumeScriptContext: () => '',
    enqueue,
    trackAgentWork,
    extractMemoryText,
    formatScriptContext: () => '',
    getTopicId: () => undefined,
    lastScriptOutputs: new Map(),
    parseSlashCommand,
    replyWithError: async (ctx, message) => {
      await ctx.reply(message);
    },
    replyWithResponse: async () => {},
    resolveEffectiveAgentId,
    runAgentForChat: agentRunner.runAgentForChat,
    runScriptCommand: async () => '',
    scriptManager: { getScriptMetadata: async () => ({}) },
    sendResponseToChat: async (chatId, response, sendOpts) => {
      sentResponses.push({ chatId, response, sendOpts });
    },
    startTyping: () => () => {},
  });

  const textHandler = bot.handlers.get('text');
  assert.ok(textHandler);

  async function sendText(text) {
    const ctx = {
      chat: { id: 12345 },
      message: { text },
      reply: async () => {},
      sendChatAction: async () => {},
    };

    textHandler(ctx);
    // Wait for the main queue to finish (fast — just captures user memory)
    const queueKey = buildTopicKey(ctx.chat.id, undefined);
    const queued = queues.get(queueKey);
    if (queued) await queued;
  }

  // Send first message — main queue finishes fast, agent work dispatched
  await sendText('Hola equipo');

  // Send second message immediately — main queue is free, accepts it
  await sendText('¿Seguimos por el mismo hilo?');

  // Now wait for all agent work to complete (runs in parallel)
  await Promise.all(agentWorkPromises);

  // Agent responses are sent via sendResponseToChat
  assert.equal(sentResponses.length, 2);
  assert.equal(sentResponses[0].response, 'Primera respuesta');
  assert.equal(sentResponses[1].response, 'Segunda respuesta');

  assert.equal(buildCalls.length, 2);
  assert.equal(buildCalls[0].threadId, undefined);
  assert.equal(buildCalls[1].threadId, 'thread-1');

  const firstPrompt = promptHistory[0];
  const secondPrompt = promptHistory[1];
  assert.match(firstPrompt, /BOOTSTRAP\(12345:root:fake\)/);
  assert.match(firstPrompt, /MEMORY_CONTEXT/);
  assert.match(firstPrompt, /Hola equipo/);
  assert.match(secondPrompt, /\u00bfSeguimos por el mismo hilo\?/);
  assert.doesNotMatch(secondPrompt, /BOOTSTRAP\(/);

  // User events captured in main queue, assistant events captured in agent queue.
  // With instant mock responses, agent work for msg 1 completes before msg 2 arrives.
  assert.equal(capturedEvents.length, 4);
  const roles = capturedEvents.map((event) => `${event.role}:${event.kind}`);
  assert.equal(roles.filter((r) => r === 'user:text').length, 2);
  assert.equal(roles.filter((r) => r === 'assistant:text').length, 2);

  const persistedThreadId = threads.get(buildThreadKey(12345, undefined, 'fake'));
  assert.equal(persistedThreadId, 'thread-1');
});
