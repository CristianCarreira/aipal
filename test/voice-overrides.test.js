const { test } = require('node:test');
const assert = require('node:assert');
const {
  clearVoiceOverride,
  isVoiceModeEnabled,
  setVoiceOverride,
} = require('../src/voice-overrides');

test('voice-overrides management', () => {
  const overrides = new Map();
  const chatId = 111;
  const topicId = 222;

  assert.strictEqual(isVoiceModeEnabled(overrides, chatId, topicId), false);

  setVoiceOverride(overrides, chatId, topicId, true);
  assert.strictEqual(isVoiceModeEnabled(overrides, chatId, topicId), true);

  setVoiceOverride(overrides, chatId, topicId, false);
  assert.strictEqual(isVoiceModeEnabled(overrides, chatId, topicId), false);

  clearVoiceOverride(overrides, chatId, topicId);
  assert.strictEqual(isVoiceModeEnabled(overrides, chatId, topicId), false);
});

test('voice-overrides root topic normalization', () => {
  const overrides = new Map();
  const chatId = 111;

  setVoiceOverride(overrides, chatId, undefined, true);
  assert.strictEqual(isVoiceModeEnabled(overrides, chatId, undefined), true);
  assert.strictEqual(isVoiceModeEnabled(overrides, chatId, 'root'), true);
});
