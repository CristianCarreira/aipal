function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function buildProgressBar(pct, length = 10) {
  const filled = Math.round((pct / 100) * length);
  const empty = length - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function registerUsageCommand(options) {
  const { bot, getUsageStats, getTopicId } = options;

  bot.command('usage', async (ctx) => {
    const chatId = ctx.chat?.id;
    const stats = getUsageStats(chatId);

    const lines = [
      `Token usage (${stats.date}):`,
      `  Estimated: ${formatNumber(stats.totalTokens)} tokens (input: ${formatNumber(stats.totalInput)} / output: ${formatNumber(stats.totalOutput)})`,
      `  Messages: ${stats.totalMessages}`,
    ];

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
