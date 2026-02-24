const TYPING_INTERVAL_MS = 4000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const TASK_TTL_MS = 60 * 60 * 1000; // 1 hour

function createBackgroundTaskManager(options) {
  const {
    bot,
    buildMemoryThreadKey,
    captureMemoryEvent,
    extractMemoryText,
    resolveEffectiveAgentId,
    runAgentForChat,
    sendResponseToChat,
  } = options;

  let nextId = 1;
  const tasks = new Map();
  const chains = new Map(); // threadKey → promise chain for serialization

  function dispatch(chatId, topicId, prompt, runOptions = {}) {
    const id = nextId++;
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const memoryThreadKey = buildMemoryThreadKey(chatId, topicId, effectiveAgentId);
    const threadKey = memoryThreadKey;

    const taskInfo = {
      id,
      chatId,
      topicId,
      prompt: String(prompt || '').slice(0, 80),
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    tasks.set(id, taskInfo);

    // Typing indicator
    const actionExtra = topicId ? { message_thread_id: topicId } : {};
    const sendTyping = () => {
      bot.telegram
        .sendChatAction(chatId, 'typing', actionExtra)
        .catch((err) => console.error('Background typing error', err));
    };
    sendTyping();
    const typingTimer = setInterval(sendTyping, TYPING_INTERVAL_MS);

    const work = async () => {
      try {
        const response = await runAgentForChat(chatId, prompt, {
          topicId,
          ...runOptions,
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
        await sendResponseToChat(chatId, response, { topicId });
        taskInfo.status = 'completed';
      } catch (err) {
        console.error(`Background task #${id} failed:`, err);
        taskInfo.status = 'failed';
        taskInfo.error = err.message || String(err);
        try {
          const errExtra = topicId ? { message_thread_id: topicId } : {};
          await bot.telegram.sendMessage(
            chatId,
            `Task #${id} failed: ${err.message}`,
            errExtra
          );
        } catch {}
      } finally {
        clearInterval(typingTimer);
        taskInfo.finishedAt = Date.now();
      }
    };

    // Serialize tasks for the same threadKey
    const prev = chains.get(threadKey) || Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    chains.set(threadKey, next);
    next.finally(() => {
      if (chains.get(threadKey) === next) {
        chains.delete(threadKey);
      }
    });

    return taskInfo;
  }

  function getStatus(chatId, topicId) {
    const result = [];
    for (const task of tasks.values()) {
      if (task.chatId !== chatId) continue;
      if (topicId !== undefined && task.topicId !== topicId) continue;
      result.push(task);
    }
    return result;
  }

  function cancelTask(taskId) {
    const task = tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.status = 'cancelled';
    task.finishedAt = Date.now();
    return true;
  }

  function getPendingPromises() {
    return Array.from(chains.values());
  }

  // Prune completed/failed tasks older than TTL
  function cleanup() {
    const now = Date.now();
    for (const [id, task] of tasks) {
      if (
        task.status !== 'running' &&
        task.finishedAt &&
        now - task.finishedAt > TASK_TTL_MS
      ) {
        tasks.delete(id);
      }
    }
  }

  const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  return {
    dispatch,
    getStatus,
    cancelTask,
    getPendingPromises,
    cleanup,
  };
}

module.exports = {
  createBackgroundTaskManager,
};
