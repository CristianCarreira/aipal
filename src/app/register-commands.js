const { registerCronCommand } = require('../commands/cron');
const { registerHelpCommands } = require('../commands/help');
const { registerMemoryCommand } = require('../commands/memory');
const { registerSettingsCommands } = require('../commands/settings');
const { registerStatusCommand } = require('../commands/status');
const { registerUsageCommand } = require('../commands/usage');

function registerCommands(options) {
  registerHelpCommands(options);
  registerSettingsCommands(options);
  registerCronCommand(options);
  registerMemoryCommand(options);
  registerStatusCommand(options);
  registerUsageCommand(options);
}

module.exports = {
  registerCommands,
};
