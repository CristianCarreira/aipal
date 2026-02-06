const { buildTopicKey } = require('./thread-store');

function getVoiceOverrideKey(chatId, topicId) {
  return buildTopicKey(chatId, topicId);
}

function isVoiceModeEnabled(overrides, chatId, topicId) {
  return overrides.get(getVoiceOverrideKey(chatId, topicId)) === 'on';
}

function setVoiceOverride(overrides, chatId, topicId, enabled) {
  const key = getVoiceOverrideKey(chatId, topicId);
  overrides.set(key, enabled ? 'on' : 'off');
  return key;
}

function clearVoiceOverride(overrides, chatId, topicId) {
  return overrides.delete(getVoiceOverrideKey(chatId, topicId));
}

module.exports = {
  clearVoiceOverride,
  getVoiceOverrideKey,
  isVoiceModeEnabled,
  setVoiceOverride,
};
