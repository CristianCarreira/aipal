function registerMemoryCommand(options) {
  const {
    bot,
    buildMemoryThreadKey,
    buildTopicKey,
    curateMemory,
    enqueue,
    extractCommandValue,
    getMemoryStatus,
    getThreadTail,
    memoryRetrievalLimit,
    persistMemory,
    replyWithError,
    resolveEffectiveAgentId,
    searchMemory,
    setMemoryEventsSinceCurate,
    startTyping,
    getTopicId,
  } = options;

  bot.command('memory', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    const parts = value ? value.split(/\s+/).filter(Boolean) : [];
    const subcommand = (parts[0] || 'status').toLowerCase();
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const topicKey = buildTopicKey(chatId, topicId);
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId);
    const threadKey = buildMemoryThreadKey(chatId, topicId, effectiveAgentId);

    if (subcommand === 'status') {
      try {
        const status = await getMemoryStatus();
        const lines = [
          `Memory file: ${status.memoryPath}`,
          `Thread files: ${status.threadFiles}`,
          `Total events: ${status.totalEvents}`,
          `Indexed events: ${status.indexedEvents}`,
          `Index path: ${status.indexPath || '(unavailable)'}`,
          `FTS enabled: ${status.indexSupportsFts ? 'yes' : 'no'}`,
          `Events today: ${status.eventsToday}`,
          `Last curated: ${status.lastCuratedAt || '(never)'}`,
        ];
        await ctx.reply(lines.join('\n'));
      } catch (err) {
        await replyWithError(ctx, 'Failed to read memory status.', err);
      }
      return;
    }

    if (subcommand === 'tail') {
      const parsed = Number(parts[1] || 10);
      const limit = Number.isFinite(parsed)
        ? Math.max(1, Math.min(50, Math.trunc(parsed)))
        : 10;
      try {
        const events = await getThreadTail(threadKey, { limit });
        if (!events.length) {
          await ctx.reply('No memory events in this conversation yet.');
          return;
        }
        const lines = events.map((event) => {
          const ts = String(event.createdAt || '').replace('T', ' ').slice(0, 16);
          const who = event.role === 'assistant' ? 'assistant' : 'user';
          const text = String(event.text || '').replace(/\s+/g, ' ').trim();
          return `- [${ts}] ${who}: ${text}`;
        });
        await ctx.reply(lines.join('\n'));
      } catch (err) {
        await replyWithError(ctx, 'Failed to read thread memory tail.', err);
      }
      return;
    }

    if (subcommand === 'search') {
      const query = parts.slice(1).join(' ').trim();
      if (!query) {
        await ctx.reply('Usage: /memory search <query>');
        return;
      }
      const parsedLimit = Number(parts[parts.length - 1]);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(20, Math.trunc(parsedLimit)))
        : memoryRetrievalLimit;
      try {
        const hits = await searchMemory({
          query,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          limit,
        });
        if (!hits.length) {
          await ctx.reply('No relevant memory found for that query.');
          return;
        }
        const lines = hits.map((hit) => {
          const ts = String(hit.createdAt || '').replace('T', ' ').slice(0, 16);
          const who = hit.role === 'assistant' ? 'assistant' : 'user';
          const text = String(hit.text || '').replace(/\s+/g, ' ').trim();
          const score = Number(hit.score || 0).toFixed(2);
          return `- [${ts}] (${hit.scope}, ${who}, score=${score}) ${text}`;
        });
        await ctx.reply(lines.join('\n'));
      } catch (err) {
        await replyWithError(ctx, 'Memory search failed.', err);
      }
      return;
    }

    if (subcommand === 'curate') {
      enqueue(`${topicKey}:memory-curate`, async () => {
        const stopTyping = startTyping(ctx);
        try {
          const result = await persistMemory(() => curateMemory());
          setMemoryEventsSinceCurate(0);
          await ctx.reply(
            [
              'Memory curated.',
              `Events processed: ${result.eventsProcessed}`,
              `Thread files: ${result.threadFiles}`,
              `Output bytes: ${result.bytes}`,
              `Updated: ${result.lastCuratedAt}`,
            ].join('\n')
          );
        } catch (err) {
          await replyWithError(ctx, 'Memory curation failed.', err);
        } finally {
          stopTyping();
        }
      });
      return;
    }

    await ctx.reply('Usage: /memory [status|tail [n]|search <query>|curate]');
  });
}

module.exports = {
  registerMemoryCommand,
};
