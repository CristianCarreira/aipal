const MAX_LOG_CHARS = 50000;

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

  const runningJobs = new Map();

  function getRunningJobs() {
    return new Map(runningJobs);
  }

  function getJobLogs(jobId) {
    const entry = runningJobs.get(jobId);
    if (!entry) return null;
    return {
      startedAt: entry.startedAt,
      logs: entry.logs.join(''),
    };
  }

  async function handleCronTrigger(chatId, prompt, triggerOptions = {}) {
    const { jobId, agent, model, topicId, cwd } = triggerOptions;
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
    const logChunks = [];
    let totalLogChars = 0;
    if (jobId) {
      runningJobs.set(jobId, { startedAt: Date.now(), chatId, topicId, logs: logChunks });
    }
    const onOutput = jobId
      ? (chunk) => {
          const text = String(chunk);
          if (totalLogChars < MAX_LOG_CHARS) {
            logChunks.push(text);
            totalLogChars += text.length;
          }
        }
      : undefined;
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
        model,
        topicId,
        cwd,
        source: 'cron',
        onOutput,
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
    } finally {
      if (jobId) {
        runningJobs.delete(jobId);
      }
    }
  }

  return { handleCronTrigger, getRunningJobs, getJobLogs };
}

module.exports = {
  createCronHandler,
};
