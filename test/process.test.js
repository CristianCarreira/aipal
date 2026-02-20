const assert = require('node:assert/strict');
const test = require('node:test');

const { splitArgs } = require('../src/services/scripts');

test('splitArgs handles quotes and spaces', () => {
  const args = splitArgs('one "two three" four');
  assert.deepEqual(args, ['one', 'two three', 'four']);
});

test('splitArgs handles escapes in unquoted and quoted segments', () => {
  const args = splitArgs('one\\ two "three\\"four" five');
  assert.deepEqual(args, ['one two', 'three"four', 'five']);
});
