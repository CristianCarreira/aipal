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
  const activeTasks = [];
  function addActiveTask(entry) {
    const task = { ...entry, startTime: Date.now() };
    activeTasks.push(task);
    return task;
  }
  function removeActiveTask(entry) {
    const idx = activeTasks.indexOf(entry);
    if (idx >= 0) activeTasks.splice(idx, 1);
  }
  function getActiveTasksSummary() {
    return '';
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
    addActiveTask,
    bot,
    buildMemoryThreadKey: buildThreadKey,
    buildTopicKey,
    captureMemoryEvent,
    consumeScriptContext: () => '',
    enqueue,
    getActiveTasksSummary,
    removeActiveTask,
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

test('thread rotation resets threadId after N turns and re-injects compact bootstrap', async () => {
  const threads = new Map();
  const threadTurns = new Map();
  const buildCalls = [];
  const promptHistory = [];
  const bootstrapCalls = [];
  let persistThreadsCalled = 0;
  let turnCounter = 0;

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      buildCalls.push(options);
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      turnCounter++;
      return { text: `reply-${turnCounter}`, threadId: `thread-${turnCounter}`, sawJson: true };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async (opts) => {
      bootstrapCalls.push(opts);
      return `BOOTSTRAP(${opts.threadKey}${opts.compact ? ',compact' : ''})`;
    },
    buildMemoryRetrievalContext: async () => 'RETRIEVAL',
    buildPrompt: (text) => text,
    documentDir: '/tmp',
    execLocal: async (_cmd, _args, options) => {
      promptHistory.push((options && options.env && options.env.AIPAL_PROMPT) || '');
      return 'output';
    },
    fileInstructionsEvery: 100,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => { persistThreadsCalled++; },
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadRotationTurns: 3,
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
  });

  // Turn 1: new thread — should include full bootstrap (compact=false)
  await agentRunner.runAgentForChat(100, 'message one');
  assert.match(promptHistory[0], /BOOTSTRAP\(/);
  assert.equal(buildCalls[0].threadId, undefined);
  assert.equal(bootstrapCalls[0].compact, false);

  // Turn 2: has threadId — no bootstrap
  await agentRunner.runAgentForChat(100, 'message two');
  assert.doesNotMatch(promptHistory[1], /BOOTSTRAP\(/);
  assert.ok(buildCalls[1].threadId);

  // Turn 3: turnCount >= 3 triggers rotation — thread deleted, compact bootstrap re-injected
  await agentRunner.runAgentForChat(100, 'message three');
  assert.match(promptHistory[2], /BOOTSTRAP\(/);
  assert.match(promptHistory[2], /compact/);
  assert.equal(buildCalls[2].threadId, undefined);
  assert.equal(bootstrapCalls[1].compact, true);

  // Turn 4 (post-rotation): new thread established, continues without bootstrap
  await agentRunner.runAgentForChat(100, 'message four');
  assert.doesNotMatch(promptHistory[3], /BOOTSTRAP\(/);
  assert.ok(buildCalls[3].threadId);

  assert.ok(persistThreadsCalled >= 1, 'persistThreads should have been called');
});

test('trivial messages (< 6 chars) skip memory retrieval', async () => {
  const threads = new Map();
  const threadTurns = new Map();
  const retrievalCalls = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      return { text: 'ok', threadId: 'thread-1', sawJson: true };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async () => 'BOOTSTRAP',
    buildMemoryRetrievalContext: async (opts) => {
      retrievalCalls.push(opts.query);
      return 'RETRIEVAL';
    },
    buildPrompt: (text) => text,
    documentDir: '/tmp',
    execLocal: async () => 'output',
    fileInstructionsEvery: 100,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadRotationTurns: 0,
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
  });

  // Short messages should skip retrieval
  await agentRunner.runAgentForChat(200, 'ok');
  await agentRunner.runAgentForChat(200, 'sí');
  await agentRunner.runAgentForChat(200, 'no');

  assert.equal(retrievalCalls.length, 0, 'No retrieval calls for short messages');

  // Normal-length message should trigger retrieval
  await agentRunner.runAgentForChat(200, 'cuéntame más sobre el proyecto');
  assert.equal(retrievalCalls.length, 1, 'Retrieval called for normal message');
  assert.equal(retrievalCalls[0], 'cuéntame más sobre el proyecto');
});

test('retrieval cache avoids redundant calls for same query within TTL', async () => {
  const threads = new Map();
  const threadTurns = new Map();
  const retrievalCalls = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      return { text: 'ok', threadId: 'thread-1', sawJson: true };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async () => 'BOOTSTRAP',
    buildMemoryRetrievalContext: async (opts) => {
      retrievalCalls.push(opts.query);
      return 'RETRIEVAL';
    },
    buildPrompt: (text) => text,
    documentDir: '/tmp',
    execLocal: async () => 'output',
    fileInstructionsEvery: 100,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadRotationTurns: 0,
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
  });

  // First call — triggers retrieval
  await agentRunner.runAgentForChat(300, 'how does the memory system work?');
  assert.equal(retrievalCalls.length, 1);

  // Same query, same chat — should be cached
  await agentRunner.runAgentForChat(300, 'how does the memory system work?');
  assert.equal(retrievalCalls.length, 1, 'Second identical query should hit cache');

  // Different query — triggers new retrieval
  await agentRunner.runAgentForChat(300, 'explain the cron scheduler');
  assert.equal(retrievalCalls.length, 2, 'Different query should trigger retrieval');

  // Same query but different chat — triggers new retrieval (different cache key)
  await agentRunner.runAgentForChat(400, 'how does the memory system work?');
  assert.equal(retrievalCalls.length, 3, 'Same query from different chat should trigger retrieval');
});

test('compact bootstrap truncates soul and tools content', async () => {
  const { createMemoryService } = require('../src/services/memory');

  const longSoul = 'S'.repeat(2000);
  const longTools = 'T'.repeat(2000);
  const shortMemory = 'Memory content here';

  const service = createMemoryService({
    appendMemoryEvent: async () => {},
    buildThreadBootstrap: async () => '',
    configPath: '/tmp/test-config.json',
    curateMemory: async () => ({}),
    documentDir: '/tmp',
    extractDocumentTokens: (text) => ({ cleanedText: text }),
    extractImageTokens: (text) => ({ cleanedText: text }),
    imageDir: '/tmp',
    memoryCaptureMaxChars: 500,
    memoryCurateEvery: 20,
    memoryPath: '/tmp/memory.md',
    persistMemory: async (task) => task(),
    readMemory: async () => ({ exists: true, content: shortMemory }),
    readSoul: async () => ({ exists: true, content: longSoul }),
    readTools: async () => ({ exists: true, content: longTools }),
    soulPath: '/tmp/soul.md',
    toolsPath: '/tmp/tools.md',
    getMemoryEventsSinceCurate: () => 0,
    setMemoryEventsSinceCurate: () => {},
  });

  // Full bootstrap should include all content
  const full = await service.buildBootstrapContext({ compact: false });
  assert.ok(full.includes(longSoul), 'Full bootstrap includes entire soul');
  assert.ok(full.includes(longTools), 'Full bootstrap includes entire tools');

  // Compact bootstrap should truncate soul and tools
  const compact = await service.buildBootstrapContext({ compact: true });
  assert.ok(!compact.includes(longSoul), 'Compact bootstrap truncates soul');
  assert.ok(!compact.includes(longTools), 'Compact bootstrap truncates tools');
  assert.ok(compact.includes('[SOUL]'), 'Compact bootstrap still has SOUL tags');
  assert.ok(compact.includes('[TOOLS]'), 'Compact bootstrap still has TOOLS tags');
  assert.ok(compact.includes(shortMemory), 'Compact bootstrap keeps full memory');

  // Verify truncation size: ~800 chars + ellipsis
  const soulMatch = compact.match(/\[SOUL\]\n([\s\S]*?)\n\[\/SOUL\]/);
  assert.ok(soulMatch, 'Soul section found in compact bootstrap');
  assert.ok(soulMatch[1].length <= 800, `Soul truncated to <=800 chars (got ${soulMatch[1].length})`);
});

test('token estimation accounts for accumulated thread context', async () => {
  const threads = new Map();
  const threadTurns = new Map();
  const tokenCalls = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      // Simulate a long response (~2000 chars)
      return { text: 'R'.repeat(2000), threadId: 'thread-1', sawJson: true };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async () => 'BOOTSTRAP',
    buildMemoryRetrievalContext: async () => '',
    buildPrompt: (text) => text,
    documentDir: '/tmp',
    execLocal: async () => 'output',
    fileInstructionsEvery: 100,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadRotationTurns: 0,
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
    onTokenUsage: (usage) => tokenCalls.push(usage),
  });

  // Turn 1: new thread — input is just the prompt (bootstrap + prompt)
  await agentRunner.runAgentForChat(500, 'Hello there friend');
  // Input call (phase 1) then output call (phase 2)
  assert.equal(tokenCalls.length, 2);
  const turn1Input = tokenCalls[0].inputTokens;
  const turn1Output = tokenCalls[1].outputTokens;
  assert.ok(turn1Input > 0);
  assert.ok(turn1Output > 0);

  // Turn 2: resuming thread — input should include accumulated context
  tokenCalls.length = 0;
  await agentRunner.runAgentForChat(500, 'Follow up message');
  assert.equal(tokenCalls.length, 2);
  const turn2Input = tokenCalls[0].inputTokens;
  // Turn 2 input should be MUCH larger than turn 1 because it includes
  // the accumulated context (turn 1 prompt + turn 1 response + turn 2 prompt)
  assert.ok(
    turn2Input > turn1Input,
    `Turn 2 input (${turn2Input}) should be larger than turn 1 (${turn1Input}) due to accumulated context`
  );

  // Turn 3: accumulated grows further
  tokenCalls.length = 0;
  await agentRunner.runAgentForChat(500, 'Third message');
  const turn3Input = tokenCalls[0].inputTokens;
  assert.ok(
    turn3Input > turn2Input,
    `Turn 3 input (${turn3Input}) should be larger than turn 2 (${turn2Input})`
  );
});

test('real usage from CLI corrects estimated tokens', async () => {
  const threads = new Map();
  const threadTurns = new Map();
  const tokenCalls = [];

  const agent = {
    id: 'claude',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      return {
        text: 'Response text',
        threadId: 'thread-1',
        sawJson: true,
        usage: { inputTokens: 3000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 },
        costUsd: 0.0125,
      };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async () => 'BOOTSTRAP',
    buildMemoryRetrievalContext: async () => '',
    buildPrompt: (text) => text,
    documentDir: '/tmp',
    execLocal: async () => 'output',
    fileInstructionsEvery: 100,
    getAgent: () => agent,
    getAgentLabel: () => 'Claude',
    getGlobalAgent: () => 'claude',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'claude',
    resolveThreadId,
    threadRotationTurns: 0,
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
    onTokenUsage: (usage) => tokenCalls.push(usage),
  });

  await agentRunner.runAgentForChat(500, 'Hello there friend');

  // Phase 1: estimated input tokens
  assert.equal(tokenCalls.length, 2);
  const phase1 = tokenCalls[0];
  assert.ok(phase1.inputTokens > 0, 'Phase 1 has estimated input');
  assert.equal(phase1.outputTokens, 0);

  // Phase 2: correction with real data
  const phase2 = tokenCalls[1];
  assert.equal(phase2.outputTokens, 500, 'Phase 2 uses real output tokens');
  assert.equal(phase2.costUsd, 0.0125, 'Phase 2 passes real cost');

  // Total should equal real values: 3000 input + 500 output = 3500
  const totalInput = phase1.inputTokens + phase2.inputTokens;
  const totalOutput = phase1.outputTokens + phase2.outputTokens;
  assert.equal(totalInput, 3000, 'Total input matches real usage');
  assert.equal(totalOutput, 500, 'Total output matches real usage');
});

test('thread rotation resets accumulated context estimation', async () => {
  const threads = new Map();
  const threadTurns = new Map();
  const tokenCalls = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      return { text: 'R'.repeat(2000), threadId: 'thread-1', sawJson: true };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async () => 'BOOT',
    buildMemoryRetrievalContext: async () => '',
    buildPrompt: (text) => text,
    documentDir: '/tmp',
    execLocal: async () => 'output',
    fileInstructionsEvery: 100,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadRotationTurns: 3,
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
    onTokenUsage: (usage) => tokenCalls.push(usage),
  });

  // Turns 1-2: accumulate context
  await agentRunner.runAgentForChat(600, 'message one');
  await agentRunner.runAgentForChat(600, 'message two');

  // Capture turn 2 input for comparison
  const turn2Input = tokenCalls[2].inputTokens; // index 2 = turn 2 input phase

  // Turn 3: triggers rotation — context should reset
  tokenCalls.length = 0;
  await agentRunner.runAgentForChat(600, 'message three');
  const postRotationInput = tokenCalls[0].inputTokens;

  // After rotation, input should be small again (just the new prompt, no accumulated context)
  assert.ok(
    postRotationInput < turn2Input,
    `Post-rotation input (${postRotationInput}) should be smaller than turn 2 (${turn2Input})`
  );
});

test('post-restart safety: forces rotation when threadContextChars is unknown', async () => {
  // Simulate restart: thread exists on disk but threadContextChars is empty (in-memory)
  const threads = new Map();
  threads.set('800:root:fake', 'old-thread-from-disk');
  const threadTurns = new Map();
  const bootstrapCalls = [];
  const buildCalls = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      buildCalls.push(options);
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      return { text: 'response', threadId: 'new-thread', sawJson: true };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async (opts) => {
      bootstrapCalls.push(opts);
      return 'BOOT';
    },
    buildMemoryRetrievalContext: async () => '',
    buildPrompt: (text) => text,
    documentDir: '/tmp',
    execLocal: async () => 'output',
    fileInstructionsEvery: 100,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadMaxContextChars: 40000,
    threadRotationTurns: 0,  // Turn rotation disabled
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
  });

  // First message after "restart": thread exists but context size is unknown
  await agentRunner.runAgentForChat(800, 'hello after restart');

  // Should have forced rotation (new thread, not resuming old-thread-from-disk)
  assert.equal(buildCalls[0].threadId, undefined, 'Should start new thread, not resume old one');
  assert.equal(bootstrapCalls.length, 1, 'Should inject bootstrap after forced rotation');
  assert.equal(bootstrapCalls[0].compact, true, 'Should use compact bootstrap');

  // Second message: should now have context tracked, no forced rotation
  buildCalls.length = 0;
  bootstrapCalls.length = 0;
  await agentRunner.runAgentForChat(800, 'second message after restart');
  assert.ok(buildCalls[0].threadId, 'Should resume new thread normally');
  assert.equal(bootstrapCalls.length, 0, 'No bootstrap on continuation');
});

test('style instructions only included on new threads and periodic refresh', async () => {
  const threads = new Map();
  const threadTurns = new Map();
  const promptHistory = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      return { text: 'ok', threadId: 'thread-1', sawJson: true };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async () => 'BOOTSTRAP',
    buildMemoryRetrievalContext: async () => '',
    buildPrompt,
    documentDir: '/tmp',
    execLocal: async (_cmd, _args, options) => {
      promptHistory.push((options && options.env && options.env.AIPAL_PROMPT) || '');
      return 'output';
    },
    fileInstructionsEvery: 5,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadMaxContextChars: 0,
    threadRotationTurns: 0,
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
  });

  // Turn 1: new thread — should include style instructions
  await agentRunner.runAgentForChat(900, 'hello world test');
  assert.match(promptHistory[0], /Output style for Telegram/, 'Turn 1 has style instructions');
  assert.match(promptHistory[0], /If you generate an image/, 'Turn 1 has file instructions');

  // Turns 2-4: continuing thread — should NOT include style/file instructions
  for (let i = 0; i < 3; i++) {
    await agentRunner.runAgentForChat(900, `message number ${i + 2} here`);
  }
  assert.doesNotMatch(promptHistory[1], /Output style for Telegram/, 'Turn 2 skips style');
  assert.doesNotMatch(promptHistory[2], /Output style for Telegram/, 'Turn 3 skips style');
  assert.doesNotMatch(promptHistory[3], /Output style for Telegram/, 'Turn 4 skips style');

  // Turn 5: fileInstructionsEvery=5, so should re-include
  await agentRunner.runAgentForChat(900, 'message five for test');
  assert.match(promptHistory[4], /Output style for Telegram/, 'Turn 5 refreshes style');
  assert.match(promptHistory[4], /If you generate an image/, 'Turn 5 refreshes file instructions');
});

test('context size limit forces thread rotation before turn limit', async () => {
  const threads = new Map();
  const threadTurns = new Map();
  const buildCalls = [];
  const bootstrapCalls = [];

  const agent = {
    id: 'fake',
    needsPty: false,
    mergeStderr: false,
    buildCommand(options) {
      buildCalls.push(options);
      return `echo ${options.promptExpression}`;
    },
    parseOutput() {
      // Large response to blow past context limit quickly
      return { text: 'R'.repeat(5000), threadId: 'thread-1', sawJson: true };
    },
  };

  const agentRunner = createAgentRunner({
    agentMaxBuffer: 1024 * 1024,
    agentTimeoutMs: 5000,
    buildBootstrapContext: async (opts) => {
      bootstrapCalls.push(opts);
      return 'BOOT';
    },
    buildMemoryRetrievalContext: async () => '',
    buildPrompt: (text) => text,
    documentDir: '/tmp',
    execLocal: async () => 'output',
    fileInstructionsEvery: 100,
    getAgent: () => agent,
    getAgentLabel: () => 'Fake',
    getGlobalAgent: () => 'fake',
    getGlobalModels: () => ({}),
    getGlobalThinking: () => undefined,
    getThreads: () => threads,
    imageDir: '/tmp',
    memoryRetrievalLimit: 3,
    persistThreads: async () => {},
    prefixTextWithTimestamp: (v) => v,
    resolveEffectiveAgentId: () => 'fake',
    resolveThreadId,
    threadMaxContextChars: 6000,  // Low limit — will trigger after turn 1
    threadRotationTurns: 100,     // High turn limit — won't trigger
    threadTurns,
    wrapCommandWithPty: (v) => v,
    defaultTimeZone: 'UTC',
  });

  // Turn 1: new thread, prompt ~10 chars + response 5000 chars = ~5010 accumulated
  await agentRunner.runAgentForChat(700, 'msg one');
  assert.equal(buildCalls[0].threadId, undefined, 'Turn 1 is new thread');
  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0].compact, false, 'Turn 1 is full bootstrap');

  // Turn 2: resumes thread, accumulated ~5010 < 6000 — no rotation yet
  await agentRunner.runAgentForChat(700, 'msg two');
  assert.ok(buildCalls[1].threadId, 'Turn 2 resumes existing thread');
  assert.equal(bootstrapCalls.length, 1, 'No new bootstrap on turn 2');

  // Turn 3: accumulated is now ~10k (>6000) — context limit should force rotation
  await agentRunner.runAgentForChat(700, 'msg three');
  assert.equal(buildCalls[2].threadId, undefined, 'Turn 3 should start new thread (context limit hit)');
  assert.equal(bootstrapCalls.length, 2, 'New bootstrap injected after context rotation');
  assert.equal(bootstrapCalls[1].compact, true, 'Context rotation uses compact bootstrap');

  // Verify turn limit was NOT the trigger (we set it to 100)
  assert.ok(threadTurns.get('700:root:fake') <= 3, 'Turn count is still low');
});

test('extractMemoryText truncates to memoryCaptureMaxChars', () => {
  const { createMemoryService } = require('../src/services/memory');

  const service = createMemoryService({
    appendMemoryEvent: async () => {},
    buildThreadBootstrap: async () => '',
    configPath: '/tmp/test-config.json',
    curateMemory: async () => ({}),
    documentDir: '/tmp',
    extractDocumentTokens: (text) => ({ cleanedText: text }),
    extractImageTokens: (text) => ({ cleanedText: text }),
    imageDir: '/tmp',
    memoryCaptureMaxChars: 100,
    memoryCurateEvery: 20,
    memoryPath: '/tmp/memory.md',
    persistMemory: async (task) => task(),
    readMemory: async () => ({ exists: false }),
    readSoul: async () => ({ exists: false }),
    readTools: async () => ({ exists: false }),
    soulPath: '/tmp/soul.md',
    toolsPath: '/tmp/tools.md',
    getMemoryEventsSinceCurate: () => 0,
    setMemoryEventsSinceCurate: () => {},
  });

  // Short text should pass through unchanged
  const short = service.extractMemoryText('Hello world');
  assert.equal(short, 'Hello world');

  // Long text should be truncated to ~100 chars
  const longText = 'A'.repeat(500);
  const truncated = service.extractMemoryText(longText);
  assert.ok(truncated.length <= 100, `Truncated to 100 chars (got ${truncated.length})`);
  assert.ok(truncated.endsWith('\u2026'), 'Truncated text ends with ellipsis');
});

test('text handler blocks messages when budget is exhausted', async () => {
  const bot = {
    handlers: new Map(),
    on(event, handler) { this.handlers.set(event, handler); },
    telegram: {
      sendChatAction: async () => {},
      sendMessage: async (_chatId, text) => { sentMessages.push(text); },
    },
  };
  const sentMessages = [];
  const queues = new Map();
  const enqueue = createEnqueue(queues);

  registerTextHandler({
    addActiveTask: () => ({ startTime: Date.now() }),
    bot,
    buildMemoryThreadKey: () => 'key',
    buildTopicKey,
    captureMemoryEvent: async () => {},
    consumeScriptContext: () => undefined,
    enqueue,
    extractMemoryText: (v) => String(v || ''),
    formatScriptContext: () => '',
    getActiveTasksSummary: () => '',
    getTopicId: () => undefined,
    isBudgetExhausted: () => true,
    lastScriptOutputs: new Map(),
    parseSlashCommand,
    replyWithError: async () => {},
    replyWithResponse: async () => {},
    removeActiveTask: () => {},
    resolveEffectiveAgentId: () => 'fake',
    runAgentForChat: async () => { throw new Error('Should not be called'); },
    runScriptCommand: async () => 'ok',
    scriptManager: { getScriptMetadata: async () => ({}) },
    sendResponseToChat: async () => {},
    startTyping: () => () => {},
    trackAgentWork: () => {},
  });

  const handler = bot.handlers.get('text');
  assert.ok(handler, 'text handler registered');

  await handler({
    chat: { id: 12345 },
    message: { text: 'Hello' },
  });

  // Wait for enqueue to process
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(sentMessages.length > 0, 'Should send a budget exhausted message');
  assert.ok(sentMessages[0].includes('budget'), 'Message mentions budget');
});

test('cron handler skips jobs when budget gate exceeded', async () => {
  const { createCronHandler } = require('../src/services/cron-handler');
  let agentCalled = false;

  const handler = createCronHandler({
    bot: {
      telegram: {
        sendChatAction: async () => {},
        sendMessage: async () => {},
      },
    },
    buildMemoryThreadKey: () => 'key',
    captureMemoryEvent: async () => {},
    cronBudgetGatePct: 90,
    extractMemoryText: (v) => String(v || ''),
    getBudgetPct: () => 95,
    resolveEffectiveAgentId: () => 'fake',
    runAgentForChat: async () => { agentCalled = true; return 'ok'; },
    sendResponseToChat: async () => {},
  });

  await handler(12345, 'test prompt', { jobId: 'test-job' });
  assert.equal(agentCalled, false, 'Agent should not be called when budget gate exceeded');
});

test('cron handler runs jobs when under budget gate', async () => {
  const { createCronHandler } = require('../src/services/cron-handler');
  let agentCalled = false;

  const handler = createCronHandler({
    bot: {
      telegram: {
        sendChatAction: async () => {},
        sendMessage: async () => {},
      },
    },
    buildMemoryThreadKey: () => 'key',
    captureMemoryEvent: async () => {},
    cronBudgetGatePct: 90,
    extractMemoryText: (v) => String(v || ''),
    getBudgetPct: () => 50,
    resolveEffectiveAgentId: () => 'fake',
    runAgentForChat: async () => { agentCalled = true; return 'HEARTBEAT_OK'; },
    sendResponseToChat: async () => {},
  });

  await handler(12345, 'test prompt', { jobId: 'test-job' });
  assert.equal(agentCalled, true, 'Agent should be called when under budget gate');
});
