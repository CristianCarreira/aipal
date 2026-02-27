function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function registerStatusCommand(options) {
  const { bot, getCronScheduler, getRunningCronJobs } = options;

  bot.command('status', async (ctx) => {
    const lines = ['Bot is active.'];

    const scheduler = getCronScheduler ? getCronScheduler() : null;
    if (scheduler) {
      lines.push(`Cron scheduler: active (${scheduler.tasks.size} scheduled)`);
    } else {
      lines.push('Cron scheduler: inactive');
    }

    if (getRunningCronJobs) {
      const running = getRunningCronJobs();
      if (running.size > 0) {
        const now = Date.now();
        lines.push('');
        lines.push(`⏳ Running now (${running.size}):`);
        for (const [jobId, info] of running) {
          lines.push(`  - ${jobId} (${formatDuration(now - info.startedAt)})`);
        }
      }
    }

    await ctx.reply(lines.join('\n'));
  });
}

module.exports = {
  registerStatusCommand,
};
