const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeTextForTts,
  normalizeTtsBackend,
  preferredTtsBackends,
} = require('../src/tts-utils');

test('normalizeTextForTts strips markdown and compacts whitespace', () => {
  const input = [
    '# Título',
    '',
    'Texto con **negrita**, _cursiva_ y `código`.',
    '[link](https://example.com)',
    '',
    '```js',
    'const hidden = true;',
    '```',
  ].join('\n');
  const output = normalizeTextForTts(input);
  assert.equal(output, '# Título Texto con negrita, cursiva y código. link');
});

test('normalizeTtsBackend only allows supported values', () => {
  assert.equal(normalizeTtsBackend('say'), 'say');
  assert.equal(normalizeTtsBackend('SAY'), 'say');
  assert.equal(normalizeTtsBackend('auto'), 'auto');
  assert.equal(normalizeTtsBackend('chatterbox'), 'chatterbox');
  assert.equal(normalizeTtsBackend('invalid'), 'say');
});

test('preferredTtsBackends returns backend order with fallback', () => {
  assert.deepEqual(preferredTtsBackends('say'), ['say']);
  assert.deepEqual(preferredTtsBackends('auto'), ['chatterbox', 'say']);
  assert.deepEqual(preferredTtsBackends('chatterbox'), ['chatterbox', 'say']);
});
