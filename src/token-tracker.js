const THRESHOLDS = [25, 50, 75, 85, 95];

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function createTokenTracker({ budgetDaily, sendAlert, persistUsage, loadUsage }) {
  let state = {
    date: todayDateString(),
    chats: {},
    alertsSent: [],
  };

  function ensureToday() {
    const today = todayDateString();
    if (state.date !== today) {
      state = { date: today, chats: {}, alertsSent: [] };
    }
  }

  function getTotalTokens() {
    let total = 0;
    for (const chat of Object.values(state.chats)) {
      total += chat.input + chat.output;
    }
    return total;
  }

  async function trackUsage({ chatId, topicId, inputTokens, outputTokens }) {
    ensureToday();
    const key = String(chatId || 'unknown');
    if (!state.chats[key]) {
      state.chats[key] = { input: 0, output: 0, messages: 0 };
    }
    state.chats[key].input += inputTokens;
    state.chats[key].output += outputTokens;
    state.chats[key].messages += 1;

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
    };

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
    state = { date: todayDateString(), chats: {}, alertsSent: [] };
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
          alertsSent: Array.isArray(loaded.alertsSent) ? loaded.alertsSent : [],
        };
      }
    } catch (err) {
      console.warn('Failed to load usage:', err);
    }
  }

  return {
    trackUsage,
    getUsageStats,
    resetUsage,
    hydrate,
  };
}

module.exports = {
  createTokenTracker,
  THRESHOLDS,
};
