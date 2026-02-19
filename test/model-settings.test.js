const assert = require('node:assert/strict');
const test = require('node:test');

const { isModelResetCommand, clearModelOverride } = require('../src/model-settings');

test('isModelResetCommand matches reset case-insensitively', () => {
  assert.equal(isModelResetCommand('reset'), true);
  assert.equal(isModelResetCommand('RESET'), true);
  assert.equal(isModelResetCommand(' reset '), true);
  assert.equal(isModelResetCommand('gpt-5'), false);
  assert.equal(isModelResetCommand(''), false);
});

test('clearModelOverride removes only the selected agent key', () => {
  const models = { codex: 'gpt-5', opencode: 'opencode/gpt-5-nano' };
  const { nextModels, hadOverride } = clearModelOverride(models, 'codex');

  assert.equal(hadOverride, true);
  assert.deepEqual(nextModels, { opencode: 'opencode/gpt-5-nano' });
  assert.deepEqual(models, { codex: 'gpt-5', opencode: 'opencode/gpt-5-nano' });
});

test('clearModelOverride keeps map unchanged when agent has no override', () => {
  const models = { codex: 'gpt-5' };
  const { nextModels, hadOverride } = clearModelOverride(models, 'gemini');

  assert.equal(hadOverride, false);
  assert.deepEqual(nextModels, { codex: 'gpt-5' });
});
