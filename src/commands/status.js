function registerStatusCommand(options) {
  const { bot, backgroundTasks, getTopicId } = options;

  bot.command('status', async (ctx) => {
    const chatId = ctx.chat.id;
    const topicId = getTopicId(ctx);
    const allTasks = backgroundTasks.getStatus(chatId, topicId);

    if (allTasks.length === 0) {
      await ctx.reply('No background tasks.');
      return;
    }

    const running = allTasks.filter((t) => t.status === 'running');
    const completed = allTasks.filter((t) => t.status === 'completed');
    const failed = allTasks.filter((t) => t.status === 'failed');

    const lines = [];

    if (running.length > 0) {
      lines.push('Active tasks:');
      for (const t of running) {
        const elapsed = formatDuration(Date.now() - t.startedAt);
        lines.push(`  #${t.id} — ${t.prompt} (running, ${elapsed})`);
      }
    }

    if (completed.length > 0) {
      lines.push('Completed tasks:');
      for (const t of completed) {
        lines.push(`  #${t.id} — ${t.prompt}`);
      }
    }

    if (failed.length > 0) {
      lines.push('Failed tasks:');
      for (const t of failed) {
        lines.push(`  #${t.id} — ${t.prompt}: ${t.error || 'unknown error'}`);
      }
    }

    if (running.length === 0 && completed.length === 0 && failed.length === 0) {
      lines.push('No background tasks.');
    }

    await ctx.reply(lines.join('\n'));
  });
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

module.exports = {
  registerStatusCommand,
  formatDuration,
};
