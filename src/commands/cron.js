function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function registerCronCommand(options) {
  const {
    bot,
    buildCronTriggerPayload,
    extractCommandValue,
    getCronDefaultChatId,
    getCronJobLogs,
    getCronScheduler,
    getRunningCronJobs,
    getTopicId,
    handleCronTrigger,
    loadCronJobs,
    replyWithError,
    saveCronJobs,
  } = options;

  bot.command('cron', async (ctx) => {
    const value = extractCommandValue(ctx.message.text);
    const parts = value ? value.split(/\s+/) : [];
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === 'list') {
      try {
        const jobs = await loadCronJobs();
        if (jobs.length === 0) {
          await ctx.reply('No cron jobs configured.');
          return;
        }
        const scheduler = getCronScheduler();
        const scheduledTasks = scheduler ? scheduler.tasks : new Map();
        const running = getRunningCronJobs ? getRunningCronJobs() : new Map();
        const now = Date.now();
        const lines = jobs.map((j) => {
          const isScheduled = scheduledTasks.has(j.id);
          const runInfo = running.get(j.id);
          let status;
          if (runInfo) {
            status = '⏳';
          } else if (!j.enabled) {
            status = '❌';
          } else if (isScheduled) {
            status = '✅';
          } else {
            status = '⚠️';
          }
          const topicLabel = j.topicId ? ` [📌 Topic ${j.topicId}]` : '';
          const runningLabel = runInfo
            ? ` (running ${formatDuration(now - runInfo.startedAt)})`
            : '';
          const warnLabel = j.enabled && !isScheduled && !runInfo
            ? ' (not scheduled)'
            : '';
          return `${status} ${j.id}: ${j.cron}${topicLabel}${runningLabel}${warnLabel}`;
        });
        const schedulerStatus = scheduler
          ? `Scheduler: active (${scheduledTasks.size} scheduled)`
          : 'Scheduler: inactive';
        await ctx.reply(`${schedulerStatus}\n\n${lines.join('\n')}`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to list cron jobs.', err);
      }
      return;
    }

    if (subcommand === 'show') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron show <jobId>');
        return;
      }
      try {
        const jobs = await loadCronJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) {
          await ctx.reply(
            `Cron job "${jobId}" not found. Available: ${jobs
              .map((j) => j.id)
              .join(', ')}`
          );
          return;
        }
        const status = job.enabled ? '✅ Enabled' : '❌ Disabled';
        const topicLabel = job.topicId ? `\nTopic: ${job.topicId}` : '';
        const agentLabel = job.agent ? `\nAgent: ${job.agent}` : '';
        const modelLabel = job.model ? `\nModel: ${job.model}` : '';
        const cwdLabel = job.cwd ? `\nCwd: ${job.cwd}` : '';
        const header = `${status}\nID: ${job.id}\nSchedule: ${job.cron}${topicLabel}${agentLabel}${modelLabel}${cwdLabel}\n\nPrompt:\n`;
        const prompt = job.prompt || '(empty)';
        const full = header + prompt;
        // Split into chunks if too long for Telegram (4096 limit)
        const maxLen = 3500;
        if (full.length <= maxLen) {
          await ctx.reply(full);
        } else {
          await ctx.reply(header + prompt.slice(0, maxLen - header.length) + '...');
          let offset = maxLen - header.length;
          while (offset < prompt.length) {
            const chunk = prompt.slice(offset, offset + maxLen);
            await ctx.reply(chunk);
            offset += maxLen;
          }
        }
      } catch (err) {
        await replyWithError(ctx, 'Failed to show cron job.', err);
      }
      return;
    }

    if (subcommand === 'assign') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron assign <jobId>');
        return;
      }
      const topicId = getTopicId(ctx);
      if (!topicId) {
        await ctx.reply(
          'Send this command from a topic/thread in a group to assign the cron to it.'
        );
        return;
      }
      try {
        const jobs = await loadCronJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) {
          await ctx.reply(
            `Cron job "${jobId}" not found. Available: ${jobs
              .map((j) => j.id)
              .join(', ')}`
          );
          return;
        }
        job.topicId = topicId;
        job.chatId = ctx.chat.id;
        await saveCronJobs(jobs);
        const scheduler = getCronScheduler();
        if (scheduler) await scheduler.reload();
        await ctx.reply(`Cron "${jobId}" assigned to this topic (${topicId}).`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to assign cron job.', err);
      }
      return;
    }

    if (subcommand === 'unassign') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron unassign <jobId>');
        return;
      }
      try {
        const jobs = await loadCronJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) {
          await ctx.reply(`Cron job "${jobId}" not found.`);
          return;
        }
        delete job.topicId;
        delete job.chatId;
        await saveCronJobs(jobs);
        const scheduler = getCronScheduler();
        if (scheduler) await scheduler.reload();
        await ctx.reply(`Cron "${jobId}" unassigned. Will send to default chat.`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to unassign cron job.', err);
      }
      return;
    }

    if (subcommand === 'run') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron run <jobId>');
        return;
      }
      try {
        const jobs = await loadCronJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) {
          await ctx.reply(
            `Cron job "${jobId}" not found. Available: ${jobs
              .map((j) => j.id)
              .join(', ')}`
          );
          return;
        }
        const payload = buildCronTriggerPayload(
          job,
          getCronDefaultChatId() || ctx.chat.id
        );
        const topicLabel = payload.options.topicId
          ? ` topic ${payload.options.topicId}`
          : '';
        const disabledLabel = job.enabled
          ? ''
          : ' (disabled in schedule, manual run forced)';
        await ctx.reply(
          `Running cron "${job.id}" now${topicLabel}${disabledLabel}\n${payload.prompt}`
        );
        await handleCronTrigger(payload.chatId, payload.prompt, payload.options);
        await ctx.reply(`Cron "${job.id}" finished.`);
      } catch (err) {
        await replyWithError(ctx, 'Failed to run cron job.', err);
      }
      return;
    }

    if (subcommand === 'logs') {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply('Usage: /cron logs <jobId>');
        return;
      }
      if (!getCronJobLogs) {
        await ctx.reply('Logs not available.');
        return;
      }
      const result = getCronJobLogs(jobId);
      if (!result) {
        await ctx.reply(`Cron job "${jobId}" is not running.`);
        return;
      }
      const elapsed = formatDuration(Date.now() - result.startedAt);
      const logs = result.logs || '';
      if (!logs.trim()) {
        await ctx.reply(`⏳ "${jobId}" running (${elapsed}) — no output yet.`);
        return;
      }
      const maxLen = 3500;
      const tail = logs.length > maxLen ? logs.slice(-maxLen) : logs;
      const truncated = logs.length > maxLen ? '...(truncated)\n' : '';
      await ctx.reply(`⏳ "${jobId}" running (${elapsed}):\n\n${truncated}${tail}`);
      return;
    }

    if (subcommand === 'reload') {
      const scheduler = getCronScheduler();
      if (scheduler) {
        const count = await scheduler.reload();
        await ctx.reply(`Cron jobs reloaded. ${count} job(s) scheduled.`);
      } else {
        await ctx.reply(
          'Cron scheduler not running. Set cronChatId in config.json first.'
        );
      }
      return;
    }

    if (subcommand === 'chatid') {
      await ctx.reply(`Your chat ID: ${ctx.chat.id}`);
      return;
    }

    await ctx.reply('Usage: /cron [list|show|logs|reload|chatid|assign|unassign|run]');
  });
}

module.exports = {
  registerCronCommand,
};
