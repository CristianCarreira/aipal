function isModelResetCommand(value) {
  if (!value) return false;
  return String(value).trim().toLowerCase() === 'reset';
}

function clearModelOverride(models, agentId) {
  const nextModels = { ...(models || {}) };
  const hadOverride = Object.hasOwn(nextModels, agentId);
  if (hadOverride) {
    delete nextModels[agentId];
  }
  return { nextModels, hadOverride };
}

module.exports = {
  isModelResetCommand,
  clearModelOverride,
};
