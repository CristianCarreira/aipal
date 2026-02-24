const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { splitArgs } = require('../src/services/scripts');
const { shellQuote } = require('../src/services/process');

test('splitArgs handles quotes and spaces', () => {
  const args = splitArgs('one "two three" four');
  assert.deepEqual(args, ['one', 'two three', 'four']);
});

test('splitArgs handles escapes in unquoted and quoted segments', () => {
  const args = splitArgs('one\\ two "three\\"four" five');
  assert.deepEqual(args, ['one two', 'three"four', 'five']);
});

test('shellQuote produces valid shell single-quoting', () => {
  const cases = [
    'simple',
    "it's a test",
    'has "double" quotes',
    'special $VAR `cmd` $(sub)',
    'newline\nand\ttab',
    '4ce29bc4-8a6f-417a-9565-fbfe86686a9d',
  ];
  for (const input of cases) {
    const quoted = shellQuote(input);
    const result = execFileSync('bash', ['-c', `printf '%s' ${quoted}`], {
      encoding: 'utf8',
    });
    assert.equal(result, input, `shellQuote failed for: ${input}`);
  }
});

test('shellQuote survives nested quoting (PTY wrapper simulation)', () => {
  const uuid = '4ce29bc4-8a6f-417a-9565-fbfe86686a9d';
  const innerCmd = `printf '%s' ${shellQuote(uuid)}`;
  const outerCmd = `bash -c ${shellQuote(innerCmd)}`;
  const result = execFileSync('bash', ['-c', outerCmd], { encoding: 'utf8' });
  assert.equal(result, uuid);
});
