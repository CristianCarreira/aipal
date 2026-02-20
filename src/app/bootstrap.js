function bootstrapApp(options) {
  const { bot, initializeApp, installShutdownHooks } = options;

  initializeApp();
  bot.launch();
  installShutdownHooks();
}

module.exports = {
  bootstrapApp,
};
