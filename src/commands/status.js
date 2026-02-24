function registerStatusCommand(options) {
  const { bot } = options;

  bot.command('status', async (ctx) => {
    await ctx.reply('Bot is active.');
  });
}

module.exports = {
  registerStatusCommand,
};
