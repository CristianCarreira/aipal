function createCronHandler(options) {
  const {
    bot,
    buildMemoryThreadKey,
    captureMemoryEvent,
    cronBudgetGatePct,
    extractMemoryText,
    getBudgetPct,
    resolveEffectiveAgentId,
    runAgentForChat,
    sendResponseToChat,
  } = options;

  return async function handleCronTrigger(chatId, prompt, triggerOptions = {}) {
    const { jobId, agent, topicId } = triggerOptions;
    if (cronBudgetGatePct > 0 && getBudgetPct) {
      const pct = getBudgetPct();
      if (pct !== null && pct >= cronBudgetGatePct) {
        console.warn(
          `Cron job ${jobId} skipped: budget at ${pct}% (gate: ${cronBudgetGatePct}%)`
        );
        return;
      }
    }
    const effectiveAgentId = resolveEffectiveAgentId(chatId, topicId, agent);
    const memoryThreadKey = buildMemoryThreadKey(chatId, topicId, effectiveAgentId);
    console.info(
      `Cron job ${jobId} executing for chat ${chatId} topic=${
        topicId || 'none'
      }${agent ? ` (agent: ${agent})` : ''}`
    );
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
      const response = await runAgentForChat(chatId, prompt, {
        agentId: agent,
        topicId,
        source: 'cron',
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
      const silentTokens = ['HEARTBEAT_OK', 'CURATION_EMPTY'];
      const matchedToken = silentTokens.find((t) => response.includes(t));
      if (matchedToken) {
        console.info(`Cron job ${jobId}: ${matchedToken} (silent)`);
        return;
      }
      await sendResponseToChat(chatId, response, { topicId });
    } catch (err) {
      console.error(`Cron job ${jobId} failed:`, err);
      try {
        const errExtra = topicId ? { message_thread_id: topicId } : {};
        await bot.telegram.sendMessage(
          chatId,
          `Cron job "${jobId}" failed: ${err.message}`,
          errExtra
        );
      } catch {}
    }
  };
}

module.exports = {
  createCronHandler,
};
