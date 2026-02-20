require('dotenv').config();

const { Telegraf } = require('telegraf');
const {
  AGENT_CODEX,
  getAgent,
  getAgentLabel,
  isKnownAgent,
  normalizeAgent,
} = require('./agents');
const {
  CONFIG_PATH,
  MEMORY_PATH,
  SOUL_PATH,
  TOOLS_PATH,
  loadAgentOverrides,
  loadThreads,
  readConfig,
  readMemory,
  readSoul,
  readTools,
  saveAgentOverrides,
  saveThreads,
  updateConfig,
} = require('./config-store');
const {
  clearAgentOverride,
  getAgentOverride,
  setAgentOverride,
} = require('./agent-overrides');
const {
  buildTopicKey,
  clearThreadForAgent,
  normalizeTopicId,
  resolveThreadId,
} = require('./thread-store');
const {
  appendMemoryEvent,
  buildThreadBootstrap,
  curateMemory,
  getMemoryStatus,
  getThreadTail,
} = require('./memory-store');
const {
  buildMemoryRetrievalContext,
  searchMemory,
} = require('./memory-retrieval');
const {
  loadCronJobs,
  saveCronJobs,
  buildCronTriggerPayload,
  startCronScheduler,
} = require('./cron-scheduler');
const {
  chunkText,
  formatError,
  parseSlashCommand,
  extractCommandValue,
  extensionFromMime,
  extensionFromUrl,
  getAudioPayload,
  getImagePayload,
  getDocumentPayload,
  isPathInside,
  extractImageTokens,
  extractDocumentTokens,
  chunkMarkdown,
  markdownToTelegramHtml,
  buildPrompt,
} = require('./message-utils');
const {
  isModelResetCommand,
  clearModelOverride,
} = require('./model-settings');
const {
  createAccessControlMiddleware,
  parseAllowedUsersEnv,
} = require('./access-control');

const { ScriptManager } = require('./script-manager');
const { prefixTextWithTimestamp, DEFAULT_TIME_ZONE } = require('./time-utils');
const { installLogTimestamps } = require('./app/logging');
const {
  AGENT_MAX_BUFFER,
  AGENT_TIMEOUT_MS,
  DOCUMENT_CLEANUP_INTERVAL_MS,
  DOCUMENT_DIR,
  DOCUMENT_TTL_HOURS,
  FILE_INSTRUCTIONS_EVERY,
  IMAGE_CLEANUP_INTERVAL_MS,
  IMAGE_DIR,
  IMAGE_TTL_HOURS,
  MEMORY_CURATE_EVERY,
  MEMORY_RETRIEVAL_LIMIT,
  SCRIPT_NAME_REGEX,
  SCRIPTS_DIR,
  SCRIPT_TIMEOUT_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  WHISPER_CMD,
  WHISPER_LANGUAGE,
  WHISPER_MODEL,
  WHISPER_TIMEOUT_MS,
} = require('./app/env');
const { createAppState } = require('./app/state');
const { execLocal, shellQuote, wrapCommandWithPty } = require('./services/process');
const { createEnqueue } = require('./services/queue');
const { createAgentRunner } = require('./services/agent-runner');
const { createFileService } = require('./services/files');
const { createMemoryService } = require('./services/memory');
const { createScriptService } = require('./services/scripts');
const { createTelegramReplyService } = require('./services/telegram-reply');
const { registerCommands } = require('./app/register-commands');

installLogTimestamps();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const allowedUsers = parseAllowedUsersEnv(process.env.ALLOWED_USERS);

// Access control middleware: must be registered before any other handlers
if (allowedUsers.size > 0) {
  console.log(`Configured with ${allowedUsers.size} allowed users.`);
  bot.use(
    createAccessControlMiddleware(allowedUsers, {
      onUnauthorized: ({ userId, username }) => {
        console.warn(
          `Unauthorized access attempt from user ID ${userId} (${
            username || 'no username'
          })`
        );
      },
    })
  );
} else {
  console.warn(
    'WARNING: No ALLOWED_USERS configured. The bot is open to everyone.'
  );
}

const appState = createAppState({ defaultAgent: AGENT_CODEX });
const { queues, threadTurns, lastScriptOutputs } = appState;
let { threads, threadsPersist, agentOverrides, agentOverridesPersist, memoryPersist } = appState;
const SCRIPT_CONTEXT_MAX_CHARS = 8000;
let memoryEventsSinceCurate = 0;
let globalThinking;
let globalAgent = AGENT_CODEX;
let globalModels = {};
let cronDefaultChatId = null;
const enqueue = createEnqueue(queues);

const scriptManager = new ScriptManager(SCRIPTS_DIR);
const scriptService = createScriptService({
  execLocal,
  isPathInside,
  scriptNameRegex: SCRIPT_NAME_REGEX,
  scriptsDir: SCRIPTS_DIR,
  scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
  scriptContextMaxChars: SCRIPT_CONTEXT_MAX_CHARS,
  lastScriptOutputs,
});
const { consumeScriptContext, formatScriptContext, runScriptCommand } = scriptService;

const fileService = createFileService({
  execLocal,
  extensionFromMime,
  extensionFromUrl,
  imageCleanupIntervalMs: IMAGE_CLEANUP_INTERVAL_MS,
  imageDir: IMAGE_DIR,
  imageTtlHours: IMAGE_TTL_HOURS,
  whisperCmd: WHISPER_CMD,
  whisperLanguage: WHISPER_LANGUAGE,
  whisperModel: WHISPER_MODEL,
  whisperTimeoutMs: WHISPER_TIMEOUT_MS,
  documentCleanupIntervalMs: DOCUMENT_CLEANUP_INTERVAL_MS,
  documentDir: DOCUMENT_DIR,
  documentTtlHours: DOCUMENT_TTL_HOURS,
});
const {
  downloadTelegramFile,
  safeUnlink,
  startDocumentCleanup,
  startImageCleanup,
  transcribeAudio,
} = fileService;

const memoryService = createMemoryService({
  appendMemoryEvent,
  buildThreadBootstrap,
  configPath: CONFIG_PATH,
  curateMemory,
  documentDir: DOCUMENT_DIR,
  extractDocumentTokens,
  extractImageTokens,
  imageDir: IMAGE_DIR,
  memoryCurateEvery: MEMORY_CURATE_EVERY,
  memoryPath: MEMORY_PATH,
  persistMemory,
  readMemory,
  readSoul,
  readTools,
  soulPath: SOUL_PATH,
  toolsPath: TOOLS_PATH,
  getMemoryEventsSinceCurate: () => memoryEventsSinceCurate,
  setMemoryEventsSinceCurate: (value) => {
    memoryEventsSinceCurate = value;
  },
});
const { buildBootstrapContext, captureMemoryEvent, extractMemoryText } = memoryService;

const agentRunner = createAgentRunner({
  agentMaxBuffer: AGENT_MAX_BUFFER,
  agentTimeoutMs: AGENT_TIMEOUT_MS,
  buildBootstrapContext,
  buildMemoryRetrievalContext,
  buildPrompt,
  documentDir: DOCUMENT_DIR,
  execLocal,
  fileInstructionsEvery: FILE_INSTRUCTIONS_EVERY,
  getAgent,
  getAgentLabel,
  getGlobalAgent: () => globalAgent,
  getGlobalModels: () => globalModels,
  getGlobalThinking: () => globalThinking,
  getThreads: () => threads,
  imageDir: IMAGE_DIR,
  memoryRetrievalLimit: MEMORY_RETRIEVAL_LIMIT,
  persistThreads,
  prefixTextWithTimestamp,
  resolveEffectiveAgentId,
  resolveThreadId,
  shellQuote,
  threadTurns,
  wrapCommandWithPty,
  defaultTimeZone: DEFAULT_TIME_ZONE,
});
const { runAgentForChat, runAgentOneShot } = agentRunner;

const telegramReplyService = createTelegramReplyService({
  bot,
  chunkMarkdown,
  chunkText,
  documentDir: DOCUMENT_DIR,
  extractDocumentTokens,
  extractImageTokens,
  formatError,
  imageDir: IMAGE_DIR,
  isPathInside,
  markdownToTelegramHtml,
});
const {
  replyWithError,
  replyWithResponse,
  replyWithTranscript,
  sendResponseToChat,
  startTyping,
} = telegramReplyService;

bot.catch((err) => {
  console.error('Bot error', err);
});

function persistThreads() {
  threadsPersist = threadsPersist
    .catch(() => {})
    .then(() => saveThreads(threads));
  return threadsPersist;
}

function persistAgentOverrides() {
  agentOverridesPersist = agentOverridesPersist
    .catch(() => {})
    .then(() => saveAgentOverrides(agentOverrides));
  return agentOverridesPersist;
}

function persistMemory(task) {
  memoryPersist = memoryPersist
    .catch(() => {})
    .then(task);
  return memoryPersist;
}

function resolveEffectiveAgentId(chatId, topicId, overrideAgentId) {
  return (
    overrideAgentId ||
    getAgentOverride(agentOverrides, chatId, topicId) ||
    globalAgent
  );
}

function buildMemoryThreadKey(chatId, topicId, agentId) {
  return buildThreadKey(chatId, normalizeTopicId(topicId), agentId);
}

let cronScheduler = null;

async function hydrateGlobalSettings() {
  const config = await readConfig();
  if (config.agent) globalAgent = normalizeAgent(config.agent);
  if (config.models) globalModels = { ...config.models };
  return config;
}

function getTopicId(ctx) {
  return ctx?.message?.message_thread_id;
}

bot.start((ctx) => ctx.reply(`Ready. Send a message and I will pass it to ${getAgentLabel(globalAgent)}.`));
registerCommands({
  allowedUsers,
  bot,
  buildCronTriggerPayload,
  buildMemoryThreadKey,
  buildTopicKey,
  clearAgentOverride: (chatId, topicId) =>
    clearAgentOverride(agentOverrides, chatId, topicId),
  clearModelOverride,
  clearThreadForAgent: (chatId, topicId, agentId) =>
    clearThreadForAgent(threads, chatId, topicId, agentId),
  curateMemory,
  enqueue,
  execLocal,
  extractCommandValue,
  getAgent,
  getAgentLabel,
  getAgentOverride: (chatId, topicId) =>
    getAgentOverride(agentOverrides, chatId, topicId),
  getCronDefaultChatId: () => cronDefaultChatId,
  getCronScheduler: () => cronScheduler,
  getGlobalAgent: () => globalAgent,
  getGlobalModels: () => globalModels,
  getGlobalThinking: () => globalThinking,
  getMemoryStatus,
  getThreadTail,
  getTopicId,
  handleCronTrigger,
  isKnownAgent,
  isModelResetCommand,
  loadCronJobs,
  markdownToTelegramHtml,
  memoryRetrievalLimit: MEMORY_RETRIEVAL_LIMIT,
  normalizeAgent,
  normalizeTopicId,
  persistAgentOverrides,
  persistMemory,
  persistThreads,
  replyWithError,
  resolveEffectiveAgentId,
  saveCronJobs,
  scriptManager,
  searchMemory,
  setAgentOverride: (chatId, topicId, agentId) =>
    setAgentOverride(agentOverrides, chatId, topicId, agentId),
  setGlobalAgent: (value) => {
    globalAgent = value;
  },
  setGlobalModels: (value) => {
    globalModels = value;
  },
  setGlobalThinking: (value) => {
    globalThinking = value;
  },
  setMemoryEventsSinceCurate: (value) => {
    memoryEventsSinceCurate = value;
  },
  startTyping,
  threadTurns,
  updateConfig,
  wrapCommandWithPty,
  runAgentOneShot,
});

bot.on('text', (ctx) => {
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  const text = ctx.message.text.trim();
  if (!text) return;

  const slash = parseSlashCommand(text);
  if (slash) {
    const normalized = slash.name.toLowerCase();
    if (
      [
        'start',
        'thinking',
        'agent',
        'model',
        'memory',
        'reset',
        'cron',
        'help',
        'document_scripts',
      ].includes(normalized)
    ) {
      return;
    }
    enqueue(topicKey, async () => {
      const stopTyping = startTyping(ctx);
      const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
      const memoryThreadKey = buildMemoryThreadKey(
        chatId,
        topicId,
        effectiveAgentId
      );
      try {
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'user',
          kind: 'command',
          text,
        });
        let scriptMeta = {};
        try {
          scriptMeta = await scriptManager.getScriptMetadata(slash.name);
        } catch (err) {
          console.error('Failed to read script metadata', err);
          scriptMeta = {};
        }
        const output = await runScriptCommand(slash.name, slash.args);
        const llmPrompt =
          typeof scriptMeta?.llm?.prompt === 'string' ? scriptMeta.llm.prompt.trim() : '';
        if (llmPrompt) {
          const scriptContext = formatScriptContext({
            name: slash.name,
            output,
          });
          const response = await runAgentForChat(chatId, llmPrompt, {
            topicId,
            scriptContext,
          });
          await captureMemoryEvent({
            threadKey: memoryThreadKey,
            chatId,
            topicId,
            agentId: effectiveAgentId,
            role: 'assistant',
            kind: 'text',
            text: extractMemoryText(response),
          });
          stopTyping();
          await replyWithResponse(ctx, response);
          return;
        }
        lastScriptOutputs.set(topicKey, { name: slash.name, output });
        await captureMemoryEvent({
          threadKey: memoryThreadKey,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          role: 'assistant',
          kind: 'text',
          text: extractMemoryText(output),
        });
        stopTyping();
        await replyWithResponse(ctx, output);
      } catch (err) {
        console.error(err);
        stopTyping();
        await replyWithError(ctx, `Error running /${slash.name}.`, err);
      }
    });
    return;
  }

  enqueue(topicKey, async () => {
    const stopTyping = startTyping(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(
      chatId,
      topicId,
      effectiveAgentId
    );
    try {
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'user',
        kind: 'text',
        text,
      });
      const scriptContext = consumeScriptContext(topicKey);
      const response = await runAgentForChat(chatId, text, {
        topicId,
        scriptContext,
      });
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'assistant',
        kind: 'text',
        text: extractMemoryText(response),
      });
      stopTyping();
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      stopTyping();
      await replyWithError(ctx, 'Error processing response.', err);
    }
  });
});

bot.on(['voice', 'audio', 'document'], (ctx, next) => {
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  const payload = getAudioPayload(ctx.message);
  if (!payload) return next();

  enqueue(topicKey, async () => {
    const stopTyping = startTyping(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(
      chatId,
      topicId,
      effectiveAgentId
    );
    let audioPath;
    let transcriptPath;
    try {
      audioPath = await downloadTelegramFile(ctx, payload, {
        prefix: 'audio',
        errorLabel: 'audio',
      });
      const { text, outputPath } = await transcribeAudio(audioPath);
      transcriptPath = outputPath;
      await replyWithTranscript(ctx, text, ctx.message?.message_id);
      if (!text) {
        await ctx.reply("I couldn't transcribe the audio.");
        return;
      }
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'user',
        kind: 'audio',
        text,
      });
      const response = await runAgentForChat(chatId, text, { topicId });
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'assistant',
        kind: 'text',
        text: extractMemoryText(response),
      });
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      if (err && err.code === 'ENOENT') {
        await replyWithError(
          ctx,
          "I can't find parakeet-mlx. Install it and try again.",
          err,
        );
      } else {
        await replyWithError(ctx, 'Error processing audio.', err);
      }
    } finally {
      stopTyping();
      await safeUnlink(audioPath);
      await safeUnlink(transcriptPath);
    }
  });
});

bot.on(['photo', 'document'], (ctx, next) => {
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  const payload = getImagePayload(ctx.message);
  if (!payload) return next();

  enqueue(topicKey, async () => {
    const stopTyping = startTyping(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(
      chatId,
      topicId,
      effectiveAgentId
    );
    let imagePath;
    try {
      imagePath = await downloadTelegramFile(ctx, payload, {
        dir: IMAGE_DIR,
        prefix: 'image',
        errorLabel: 'image',
      });
      const caption = (ctx.message.caption || '').trim();
      const prompt = caption || 'User sent an image.';
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'user',
        kind: 'image',
        text: prompt,
      });
      const response = await runAgentForChat(chatId, prompt, {
        topicId,
        imagePaths: [imagePath],
      });
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'assistant',
        kind: 'text',
        text: extractMemoryText(response),
      });
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Error processing image.', err);
    } finally {
      stopTyping();
    }
  });
});

bot.on('document', (ctx) => {
  const chatId = ctx.chat.id;
  const topicId = getTopicId(ctx);
  const topicKey = buildTopicKey(chatId, topicId);
  if (getAudioPayload(ctx.message) || getImagePayload(ctx.message)) return;
  const payload = getDocumentPayload(ctx.message);
  if (!payload) return;

  enqueue(topicKey, async () => {
    const stopTyping = startTyping(ctx);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(
      chatId,
      topicId,
      effectiveAgentId
    );
    let documentPath;
    try {
      documentPath = await downloadTelegramFile(ctx, payload, {
        dir: DOCUMENT_DIR,
        prefix: 'document',
        errorLabel: 'document',
      });
      const caption = (ctx.message.caption || '').trim();
      const prompt = caption || 'User sent a document.';
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'user',
        kind: 'document',
        text: prompt,
      });
      const response = await runAgentForChat(chatId, prompt, {
        topicId,
        documentPaths: [documentPath],
      });
      await captureMemoryEvent({
        threadKey: memoryThreadKey,
        chatId,
        topicId,
        agentId: effectiveAgentId,
        role: 'assistant',
        kind: 'text',
        text: extractMemoryText(response),
      });
      await replyWithResponse(ctx, response);
    } catch (err) {
      console.error(err);
      await replyWithError(ctx, 'Error processing document.', err);
    } finally {
      stopTyping();
    }
  });
});

async function handleCronTrigger(chatId, prompt, options = {}) {
  const { jobId, agent, topicId } = options;
  const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId, agent);
  const memoryThreadKey = buildMemoryThreadKey(chatId, topicId, effectiveAgentId);
  console.info(`Cron job ${jobId} executing for chat ${chatId} topic=${topicId || 'none'}${agent ? ` (agent: ${agent})` : ''}`);
  try {
    const actionExtra = topicId ? { message_thread_id: topicId } : {};
    await bot.telegram.sendChatAction(chatId, 'typing', actionExtra);
    await captureMemoryEvent({
      threadKey: memoryThreadKey,
      chatId,
      topicId,
      agentId: effectiveAgentId,
      role: 'user',
      kind: 'cron',
      text: String(prompt || ''),
    });
    const response = await runAgentForChat(chatId, prompt, { agentId: agent, topicId });
    await captureMemoryEvent({
      threadKey: memoryThreadKey,
      chatId,
      topicId,
      agentId: effectiveAgentId,
      role: 'assistant',
      kind: 'text',
      text: extractMemoryText(response),
    });
    const silentTokens = ['HEARTBEAT_OK', 'CURATION_EMPTY'];
    const matchedToken = silentTokens.find(t => response.includes(t));
    if (matchedToken) {
      console.info(`Cron job ${jobId}: ${matchedToken} (silent)`);
      return;
    }
    await sendResponseToChat(chatId, response, { topicId });
  } catch (err) {
    console.error(`Cron job ${jobId} failed:`, err);
    try {
      const errExtra = topicId ? { message_thread_id: topicId } : {};
      await bot.telegram.sendMessage(chatId, `Cron job "${jobId}" failed: ${err.message}`, errExtra);
    } catch {}
  }
}

startImageCleanup();
startDocumentCleanup();
loadThreads()
  .then((loaded) => {
    threads = loaded;
    console.info(`Loaded ${threads.size} thread(s) from disk`);
  })
  .catch((err) => console.warn('Failed to load threads:', err));
loadAgentOverrides()
  .then((loaded) => {
    agentOverrides = loaded;
    console.info(`Loaded ${agentOverrides.size} agent override(s) from disk`);
  })
  .catch((err) => console.warn('Failed to load agent overrides:', err));
hydrateGlobalSettings()
  .then((config) => {
    cronDefaultChatId = config.cronChatId || null;
    if (cronDefaultChatId) {
      cronScheduler = startCronScheduler({
        chatId: cronDefaultChatId,
        onTrigger: handleCronTrigger,
      });
    } else {
      console.info('Cron scheduler disabled (no cronChatId in config)');
    }
  })
  .catch((err) => console.warn('Failed to load config settings:', err));
bot.launch();

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.info(`Shutting down (${signal})...`);

  try {
    if (cronScheduler && typeof cronScheduler.stop === 'function') {
      cronScheduler.stop();
    }
  } catch (err) {
    console.warn('Failed to stop cron scheduler:', err);
  }

  try {
    bot.stop(signal);
  } catch (err) {
    console.warn('Failed to stop bot:', err);
  }

  const forceTimer = setTimeout(() => {
    console.warn('Forcing process exit after shutdown timeout.');
    process.exit(0);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS + 2000);
  if (typeof forceTimer.unref === 'function') forceTimer.unref();

  Promise.resolve()
    .then(async () => {
      const pending = Array.from(queues.values());
      if (pending.length > 0) {
        console.info(`Waiting for ${pending.length} queued job(s) to finish...`);
        await Promise.race([
          Promise.allSettled(pending),
          new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)),
        ]);
      }
      await Promise.race([
        Promise.allSettled([threadsPersist, agentOverridesPersist, memoryPersist]),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    })
    .catch((err) => {
      console.warn('Error during shutdown drain:', err);
    })
    .finally(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
