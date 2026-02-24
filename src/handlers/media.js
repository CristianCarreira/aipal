const PROCESSING_DELAY_MS = 10000;

function registerMediaHandlers(options) {
  const {
    addActiveTask,
    bot,
    buildMemoryThreadKey,
    buildTopicKey,
    captureMemoryEvent,
    documentDir,
    downloadTelegramFile,
    extractMemoryText,
    getAudioPayload,
    getDocumentPayload,
    getImagePayload,
    getTopicId,
    imageDir,
    enqueue,
    replyWithError,
    replyWithResponse,
    replyWithTranscript,
    removeActiveTask,
    resolveEffectiveAgentId,
    runAgentForChat,
    safeUnlink,
    sendResponseToChat,
    startTyping,
    trackAgentWork,
    transcribeAudio,
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
        stopTyping();
        dispatchAgentWork(ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, text, {});
      } catch (err) {
        console.error(err);
        stopTyping();
        if (err && err.code === 'ENOENT') {
          await replyWithError(
            ctx,
            "I can't find parakeet-mlx. Install it and try again.",
            err
          );
        } else {
          await replyWithError(ctx, 'Error processing audio.', err);
        }
      } finally {
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
          dir: imageDir,
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
        stopTyping();
        dispatchAgentWork(ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, prompt, { imagePaths: [imagePath] });
      } catch (err) {
        console.error(err);
        stopTyping();
        await replyWithError(ctx, 'Error processing image.', err);
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
          dir: documentDir,
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
        stopTyping();
        dispatchAgentWork(ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, prompt, { documentPaths: [documentPath] });
      } catch (err) {
        console.error(err);
        stopTyping();
        await replyWithError(ctx, 'Error processing document.', err);
      }
    });
  });
}

module.exports = {
  registerMediaHandlers,
};
