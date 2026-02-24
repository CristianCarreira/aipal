function registerMediaHandlers(options) {
  const {
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
    enqueueAgentWork,
    replyWithError,
    replyWithResponse,
    replyWithTranscript,
    resolveEffectiveAgentId,
    runAgentForChat,
    safeUnlink,
    sendResponseToChat,
    startTyping,
    transcribeAudio,
  } = options;

  function dispatchAgentWork(topicKey, ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, prompt, runOptions) {
    enqueueAgentWork(topicKey, async () => {
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
        const errExtra = topicId ? { message_thread_id: topicId } : {};
        await bot.telegram
          .sendMessage(chatId, `Error: ${err.message}`, errExtra)
          .catch(() => {});
      } finally {
        stopTyping();
      }
    });
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
        dispatchAgentWork(topicKey, ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, text, {});
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
        dispatchAgentWork(topicKey, ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, prompt, { imagePaths: [imagePath] });
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
        dispatchAgentWork(topicKey, ctx, chatId, topicId, memoryThreadKey, effectiveAgentId, prompt, { documentPaths: [documentPath] });
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
