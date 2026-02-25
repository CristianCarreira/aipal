const PROCESSING_DELAY_MS = 10000;

function registerTextHandler(options) {
  const {
    addActiveTask,
    bot,
    buildMemoryThreadKey,
    buildTopicKey,
    captureMemoryEvent,
    consumeScriptContext,
    enqueue,
    extractMemoryText,
    formatScriptContext,
    getActiveTasksSummary,
    getTopicId,
    lastScriptOutputs,
    parseSlashCommand,
    removeActiveTask,
    replyWithError,
    replyWithResponse,
    resolveEffectiveAgentId,
    runAgentForChat,
    runScriptCommand,
    scriptManager,
    sendResponseToChat,
    startTyping,
    isBudgetExhausted,
    trackAgentWork,
  } = options;

  function dispatchAgentWork(ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, prompt, runOptions) {
    const extra = topicId ? { message_thread_id: topicId } : {};
    const taskEntry = addActiveTask({ chatId, topicId, prompt });

    const work = (async () => {
      const stopTyping = startTyping(ctx);
      const ackTimer = setTimeout(() => {
        bot.telegram.sendMessage(chatId, 'An agent is handling this task.', extra).catch(() => {});
      }, PROCESSING_DELAY_MS);
      try {
        const response = await runAgentForChat(chatId, prompt, {
          topicId,
          ...runOptions,
        });
        clearTimeout(ackTimer);
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
      } catch (err) {
        clearTimeout(ackTimer);
        console.error('Agent call failed:', err);
        await bot.telegram
          .sendMessage(chatId, `Error: ${err.message}`, extra)
          .catch(() => {});
      } finally {
        stopTyping();
        removeActiveTask(taskEntry);
      }
    })();
    trackAgentWork(work);
  }

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
          'status',
          'usage',
        ].includes(normalized)
      ) {
        return;
      }
      enqueue(topicKey, async () => {
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
          const llmPrompt =
            typeof scriptMeta?.llm?.prompt === 'string'
              ? scriptMeta.llm.prompt.trim()
              : '';
          if (llmPrompt && isBudgetExhausted && isBudgetExhausted()) {
            const extra = topicId ? { message_thread_id: topicId } : {};
            await bot.telegram.sendMessage(
              chatId,
              'Daily token budget exhausted. Use /usage for details.',
              extra
            ).catch(() => {});
            return;
          }
          const output = await runScriptCommand(slash.name, slash.args);
          if (llmPrompt) {
            const scriptContext = formatScriptContext({
              name: slash.name,
              output,
            });
            dispatchAgentWork(ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, llmPrompt, { scriptContext });
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
          await replyWithResponse(ctx, output);
        } catch (err) {
          console.error(err);
          await replyWithError(ctx, `Error running /${slash.name}.`, err);
        }
      });
      return;
    }

    enqueue(topicKey, async () => {
      if (isBudgetExhausted && isBudgetExhausted()) {
        const extra = topicId ? { message_thread_id: topicId } : {};
        await bot.telegram.sendMessage(
          chatId,
          'Daily token budget exhausted. Messages will resume tomorrow. Use /usage for details.',
          extra
        ).catch(() => {});
        return;
      }
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
        const activeContext = getActiveTasksSummary(chatId);
        const effectivePrompt = activeContext ? `${activeContext}\n\n${text}` : text;
        dispatchAgentWork(ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, effectivePrompt, { scriptContext });
      } catch (err) {
        console.error(err);
        await replyWithError(ctx, 'Error processing response.', err);
      }
    });
  });
}

module.exports = {
  registerTextHandler,
};
