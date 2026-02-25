function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function buildProgressBar(pct, length = 10) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * length);
  const empty = length - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function registerUsageCommand(options) {
  const { bot, getUsageStats } = options;

  bot.command('usage', async (ctx) => {
    const chatId = ctx.chat?.id;
    const stats = getUsageStats(chatId);

    const lines = [
      `Token usage (${stats.date}):`,
      `  Estimated: ${formatNumber(stats.totalTokens)} tokens (input: ${formatNumber(stats.totalInput)} / output: ${formatNumber(stats.totalOutput)})`,
      `  Messages: ${stats.totalMessages}`,
    ];

    const srcParts = [];
    for (const [src, data] of Object.entries(stats.sources || {})) {
      if (data.tokens > 0) {
        srcParts.push(`${src}: ${formatNumber(data.tokens)} tok (${data.messages} msgs)`);
      }
    }
    if (srcParts.length > 0) {
      lines.push(`  Breakdown: ${srcParts.join(' | ')}`);
    }

    if (stats.budgetDaily > 0 && stats.pct != null) {
      lines.push(
        `  Budget: ${formatNumber(stats.totalTokens)} / ${formatNumber(stats.budgetDaily)} (${stats.pct}%)`
      );
      lines.push(`  ${buildProgressBar(stats.pct)} ${stats.pct}%`);
    }

    if (stats.chat) {
      lines.push('');
      lines.push(`This chat: ${formatNumber(stats.chat.tokens)} tokens, ${stats.chat.messages} messages`);
    }

    await ctx.reply(lines.join('\n'));
  });
}

module.exports = {
  registerUsageCommand,
};
