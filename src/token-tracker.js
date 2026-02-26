const THRESHOLDS = [25, 50, 75, 85, 95];

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function createTokenTracker({ budgetDaily, agentQuotas, sendAlert, persistUsage, loadUsage }) {
  const quotas = agentQuotas || {};
  let state = {
    date: todayDateString(),
    chats: {},
    sources: {},
    agents: {},
    alertsSent: [],
    totalCostUsd: 0,
  };

  function ensureToday() {
    const today = todayDateString();
    if (state.date !== today) {
      state = { date: today, chats: {}, sources: {}, agents: {}, alertsSent: [], totalCostUsd: 0 };
    }
  }

  function getTotalTokens() {
    let total = 0;
    for (const chat of Object.values(state.chats)) {
      total += chat.input + chat.output;
    }
    return total;
  }

  async function trackUsage({ chatId, topicId, inputTokens, outputTokens, source, costUsd, agentId }) {
    ensureToday();
    const key = String(chatId || 'unknown');
    if (!state.chats[key]) {
      state.chats[key] = { input: 0, output: 0, messages: 0 };
    }
    state.chats[key].input += inputTokens;
    state.chats[key].output += outputTokens;
    if (inputTokens > 0) state.chats[key].messages += 1;

    if (source) {
      if (!state.sources[source]) {
        state.sources[source] = { input: 0, output: 0, messages: 0 };
      }
      state.sources[source].input += inputTokens;
      state.sources[source].output += outputTokens;
      if (inputTokens > 0) state.sources[source].messages += 1;
    }

    if (agentId) {
      if (!state.agents[agentId]) {
        state.agents[agentId] = { input: 0, output: 0, messages: 0 };
      }
      state.agents[agentId].input += inputTokens;
      state.agents[agentId].output += outputTokens;
      if (inputTokens > 0) state.agents[agentId].messages += 1;
    }

    if (typeof costUsd === 'number' && costUsd > 0) {
      state.totalCostUsd = (state.totalCostUsd || 0) + costUsd;
    }

    if (budgetDaily > 0 && sendAlert) {
      const totalTokens = getTotalTokens();
      const pct = (totalTokens / budgetDaily) * 100;
      for (const threshold of THRESHOLDS) {
        if (pct >= threshold && !state.alertsSent.includes(threshold)) {
          state.alertsSent.push(threshold);
          try {
            await sendAlert({
              chatId: key,
              threshold,
              pct: Math.round(pct * 10) / 10,
              totalTokens,
              budgetDaily,
            });
          } catch (err) {
            console.warn(`Failed to send token alert (${threshold}%):`, err);
          }
        }
      }
    }

    if (persistUsage) {
      try {
        await persistUsage(state);
      } catch (err) {
        console.warn('Failed to persist usage:', err);
      }
    }
  }

  function getUsageStats(chatId) {
    ensureToday();
    const totalInput = Object.values(state.chats).reduce((s, c) => s + c.input, 0);
    const totalOutput = Object.values(state.chats).reduce((s, c) => s + c.output, 0);
    const totalMessages = Object.values(state.chats).reduce((s, c) => s + c.messages, 0);
    const totalTokens = totalInput + totalOutput;

    const result = {
      date: state.date,
      totalTokens,
      totalInput,
      totalOutput,
      totalMessages,
      budgetDaily,
      pct: budgetDaily > 0 ? Math.round((totalTokens / budgetDaily) * 1000) / 10 : null,
      alertsSent: [...state.alertsSent],
      sources: {},
      agents: {},
      totalCostUsd: state.totalCostUsd || 0,
    };

    for (const [src, bucket] of Object.entries(state.sources)) {
      result.sources[src] = {
        input: bucket.input,
        output: bucket.output,
        messages: bucket.messages,
        tokens: bucket.input + bucket.output,
      };
    }

    for (const [aid, bucket] of Object.entries(state.agents)) {
      const tokens = bucket.input + bucket.output;
      const quota = quotas[aid] || 0;
      result.agents[aid] = {
        input: bucket.input,
        output: bucket.output,
        messages: bucket.messages,
        tokens,
        quota,
        pct: quota > 0 ? Math.round((tokens / quota) * 1000) / 10 : null,
      };
    }

    if (chatId != null) {
      const chat = state.chats[String(chatId)];
      if (chat) {
        result.chat = {
          input: chat.input,
          output: chat.output,
          messages: chat.messages,
          tokens: chat.input + chat.output,
        };
      }
    }

    return result;
  }

  function resetUsage() {
    state = { date: todayDateString(), chats: {}, sources: {}, agents: {}, alertsSent: [], totalCostUsd: 0 };
    if (persistUsage) {
      persistUsage(state).catch((err) =>
        console.warn('Failed to persist usage after reset:', err)
      );
    }
  }

  async function hydrate() {
    if (!loadUsage) return;
    try {
      const loaded = await loadUsage();
      if (loaded && loaded.date === todayDateString()) {
        state = {
          date: loaded.date,
          chats: loaded.chats || {},
          sources: loaded.sources || {},
          agents: loaded.agents || {},
          alertsSent: Array.isArray(loaded.alertsSent) ? loaded.alertsSent : [],
          totalCostUsd: loaded.totalCostUsd || 0,
        };
      }
    } catch (err) {
      console.warn('Failed to load usage:', err);
    }
  }

  function isBudgetExhausted() {
    if (budgetDaily <= 0) return false;
    ensureToday();
    const totalTokens = getTotalTokens();
    return totalTokens >= budgetDaily;
  }

  function getBudgetPct() {
    if (budgetDaily <= 0) return null;
    ensureToday();
    const totalTokens = getTotalTokens();
    return Math.round((totalTokens / budgetDaily) * 1000) / 10;
  }

  return {
    trackUsage,
    getUsageStats,
    resetUsage,
    hydrate,
    isBudgetExhausted,
    getBudgetPct,
  };
}

module.exports = {
  createTokenTracker,
  THRESHOLDS,
};
