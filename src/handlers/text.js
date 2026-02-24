function registerTextHandler(options) {
  const {
    bot,
    buildMemoryThreadKey,
    buildTopicKey,
    captureMemoryEvent,
    consumeScriptContext,
    enqueue,
    extractMemoryText,
    formatScriptContext,
    getTopicId,
    lastScriptOutputs,
    parseSlashCommand,
    replyWithError,
    replyWithResponse,
    resolveEffectiveAgentId,
    runAgentForChat,
    runScriptCommand,
    scriptManager,
    sendResponseToChat,
    startTyping,
    trackAgentWork,
  } = options;

  function dispatchAgentWork(ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, prompt, runOptions) {
    const extra = topicId ? { message_thread_id: topicId } : {};
    bot.telegram.sendMessage(chatId, 'Processing...', extra).catch(() => {});

    const work = (async () => {
      const stopTyping = startTyping(ctx);
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
      } catch (err) {
        console.error('Agent call failed:', err);
        await bot.telegram
          .sendMessage(chatId, `Error: ${err.message}`, extra)
          .catch(() => {});
      } finally {
        stopTyping();
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
          const output = await runScriptCommand(slash.name, slash.args);
          const llmPrompt =
            typeof scriptMeta?.llm?.prompt === 'string'
              ? scriptMeta.llm.prompt.trim()
              : '';
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
        dispatchAgentWork(ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, text, { scriptContext });
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
