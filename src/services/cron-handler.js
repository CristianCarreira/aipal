const MAX_LOG_CHARS = 50000;

function createCronHandler(options) {
  const {
    bot,
    buildMemoryThreadKey,
    captureMemoryEvent,
    cronBudgetGatePct,
    extractMemoryText,
    getBudgetPct,
    isDegradedOutput,
    isOperationalEvent,
    resetThreadSession,
    resolveEffectiveAgentId,
    runAgentForChat,
    sendResponseToChat,
    stripInternalTokens,
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
      // Degraded output: the model echoed leaked tool-call XML or its own
      // role-prompt instead of executing. Never post that to the chat, and
      // reset the CLI session — once a session contains such a turn it keeps
      // resuming into it and repeats the leak every run until cleared. Checked
      // before the heartbeat branch so a leak that happens to end in a sentinel
      // is still suppressed.
      const looksDegraded =
        typeof isDegradedOutput === 'function'
          ? isDegradedOutput(response)
          : typeof isOperationalEvent === 'function' &&
            isOperationalEvent({ kind: 'text', text: response });
      if (looksDegraded) {
        console.warn(
          `Cron job ${jobId}: suppressed degraded tool-leak/role-echo output; resetting session`
        );
        if (typeof resetThreadSession === 'function') {
          try {
            await resetThreadSession(chatId, topicId, effectiveAgentId);
          } catch (resetErr) {
            console.warn(
              `Cron job ${jobId}: failed to reset session:`,
              resetErr?.message || resetErr
            );
          }
        }
        return;
      }
      // Heartbeat/curation sentinel: the cron ran with no actionable news. Show
      // what it actually reported (minus the raw token) so the run is visible
      // instead of silently dropped.
      const silentTokens = ['HEARTBEAT_OK', 'CURATION_EMPTY'];
      const matchedToken = silentTokens.find((t) => response.includes(t));
      if (matchedToken) {
        const cleaned =
          typeof stripInternalTokens === 'function'
            ? stripInternalTokens(response)
            : response.replace(/\s*(HEARTBEAT_OK|CURATION_EMPTY)\s*$/i, '').trim();
        const summary = cleaned || `✅ ${jobId || 'cron'}: sin novedades`;
        console.info(`Cron job ${jobId}: ${matchedToken} -> posting summary`);
        await sendResponseToChat(chatId, summary, { topicId });
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
