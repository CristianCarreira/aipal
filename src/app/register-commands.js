const { registerCronCommand } = require('../commands/cron');
const { registerHelpCommands } = require('../commands/help');
const { registerMemoryCommand } = require('../commands/memory');
const { registerSettingsCommands } = require('../commands/settings');

function registerCommands(options) {
  registerHelpCommands(options);
  registerSettingsCommands(options);
  registerCronCommand(options);
  registerMemoryCommand(options);
}

module.exports = {
  registerCommands,
};
