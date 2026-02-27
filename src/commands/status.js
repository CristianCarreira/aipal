function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function registerStatusCommand(options) {
  const { bot, getRunningCronJobs } = options;

  bot.command('status', async (ctx) => {
    const lines = ['Bot is active.'];
    if (getRunningCronJobs) {
      const running = getRunningCronJobs();
      if (running.size > 0) {
        const now = Date.now();
        lines.push('');
        lines.push(`⏳ Running cron jobs (${running.size}):`);
        for (const [jobId, info] of running) {
          lines.push(`  - ${jobId} (${formatDuration(now - info.startedAt)})`);
        }
      } else {
        lines.push('No cron jobs running.');
      }
    }
    await ctx.reply(lines.join('\n'));
  });
}

module.exports = {
  registerStatusCommand,
};
