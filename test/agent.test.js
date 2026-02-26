const assert = require('node:assert/strict');
const test = require('node:test');

const { getAgent } = require('../src/agents');

test('buildAgentCommand uses exec resume with thread id', () => {
  const agent = getAgent('codex');
  const command = agent.buildCommand({ prompt: 'hello', threadId: 't-123' });
  assert.match(command, /codex exec resume 't-123'/);
  assert.match(command, /--json/);
  assert.match(command, /--yolo/);
  assert.match(command, /'hello'/);
});

test('buildAgentCommand appends model and reasoning flags', () => {
  const agent = getAgent('codex');
  const command = agent.buildCommand({ prompt: 'ping', model: 'gpt-5.2', thinking: 'medium' });
  assert.match(command, /--model 'gpt-5.2'/);
  assert.match(command, /--config 'model_reasoning_effort="medium"'/);
});

test('parseAgentOutput extracts thread id and message text', () => {
  const agent = getAgent('codex');
  const output = [
    'noise',
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', text: 'hi there' },
    }),
  ].join('\n');
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, 'thread-1');
  assert.equal(parsed.text, 'hi there');
  assert.equal(parsed.sawJson, true);
});

test('parseAgentOutput prefers final channel messages for codex', () => {
  const agent = getAgent('codex');
  const output = [
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', channel: 'commentary', text: 'voy a hacer X' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', channel: 'final', text: 'hecho: resultado final' },
    }),
  ].join('\n');
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.text, 'hecho: resultado final');
});

test('parseAgentOutput falls back to last codex message when no channel exists', () => {
  const agent = getAgent('codex');
  const output = [
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', text: 'paso intermedio' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'message', text: 'respuesta final' },
    }),
  ].join('\n');
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.text, 'respuesta final');
});

test('buildAgentCommand builds claude headless command with resume', () => {
  const agent = getAgent('claude');
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const command = agent.buildCommand({ prompt: 'hello', threadId: sessionId });
  assert.match(command, /^claude /);
  assert.match(command, /-p 'hello'/);
  assert.match(command, /--output-format json/);
  assert.match(command, /--dangerously-skip-permissions/);
  assert.match(command, /--resume '550e8400-e29b-41d4-a716-446655440000'/);
});

test('buildAgentCommand uses shellQuote for claude resume regardless of threadIdExpression', () => {
  const agent = getAgent('claude');
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const command = agent.buildCommand({
    prompt: 'hello',
    threadId: sessionId,
    threadIdExpression: '"$AIPAL_THREAD_ID"',
  });
  assert.match(command, /--resume '550e8400-e29b-41d4-a716-446655440000'/);
  assert.doesNotMatch(command, /AIPAL_THREAD_ID/);
});

test('parseAgentOutput extracts claude session and result', () => {
  const agent = getAgent('claude');
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const output = JSON.stringify({ result: 'hola', session_id: sessionId });
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, sessionId);
  assert.equal(parsed.text, 'hola');
  assert.equal(parsed.sawJson, true);
});

test('buildAgentCommand builds gemini headless command', () => {
  const agent = getAgent('gemini');
  const command = agent.buildCommand({ prompt: 'hello', threadId: 'session-3' });
  assert.match(command, /^gemini /);
  assert.match(command, /-p 'hello'/);
  assert.match(command, /--output-format json/);
  assert.match(command, /--yolo/);
  assert.match(command, /--resume session-3/);
});

test('buildAgentCommand appends model flag for claude', () => {
  const agent = getAgent('claude');
  const command = agent.buildCommand({ prompt: 'hello', model: 'sonnet' });
  assert.match(command, /^claude /);
  assert.match(command, /--model sonnet/);
});

test('buildAgentCommand omits model flag for claude when not provided', () => {
  const agent = getAgent('claude');
  const command = agent.buildCommand({ prompt: 'hello' });
  assert.doesNotMatch(command, /--model/);
});

test('buildAgentCommand appends model flag for gemini', () => {
  const agent = getAgent('gemini');
  const command = agent.buildCommand({ prompt: 'hello', model: 'gemini-2.5-flash' });
  assert.match(command, /^gemini /);
  assert.match(command, /--model gemini-2.5-flash/);
});

test('buildAgentCommand omits model flag for gemini when not provided', () => {
  const agent = getAgent('gemini');
  const command = agent.buildCommand({ prompt: 'hello' });
  assert.doesNotMatch(command, /--model/);
});

test('parseAgentOutput extracts gemini response', () => {
  const agent = getAgent('gemini');
  const output = JSON.stringify({ response: 'hola' });
  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, undefined);
  assert.equal(parsed.text, 'hola');
  assert.equal(parsed.sawJson, true);
});


test('parseSessionList extracts latest gemini session id', () => {
  const agent = getAgent('gemini');
  const output = [
    'Available sessions for this project (2):',
    '  1. Foo (1 minute ago) [11111111-1111-1111-1111-111111111111]',
    '  2. Bar (just now) [22222222-2222-2222-2222-222222222222]',
  ].join('\n');
  const sessionId = agent.parseSessionList(output);
  assert.equal(sessionId, '22222222-2222-2222-2222-222222222222');
});

test('buildAgentCommand builds opencode command with env and json flag', () => {
  const agent = getAgent('opencode');
  const command = agent.buildCommand({ prompt: 'hello', threadId: 'sess-123' });
  assert.match(command, /^OPENCODE_PERMISSION='\{"\*": "allow"\}' opencode run /);
  assert.match(command, /--format json/);
  assert.match(command, /--model 'opencode\/gpt-5-nano'/);
  assert.match(command, /--continue/);
  assert.match(command, /--session 'sess-123'/);
  assert.match(command, /'hello'/);
  assert.match(command, /< \/dev\/null/);
});

test('parseAgentOutput extracts opencode ndjson result', () => {
  const agent = getAgent('opencode');
  const output = [
    'INFO log message',
    JSON.stringify({ type: 'step_start', sessionID: 'sess-456' }),
    JSON.stringify({ type: 'text', sessionID: 'sess-456', part: { text: 'hi ' } }),
    JSON.stringify({ type: 'text', sessionID: 'sess-456', part: { text: 'opencode' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'sess-456' }),
  ].join('\n');

  const parsed = agent.parseOutput(output);
  assert.equal(parsed.threadId, 'sess-456');
  assert.equal(parsed.text, 'hi opencode');
  assert.equal(parsed.sawJson, true);
});

test('listModelsCommand builds opencode models command', () => {
  const agent = getAgent('opencode');
  const command = agent.listModelsCommand();
  assert.match(command, /opencode models/);
});

test('claude parseOutput extracts usage and cost from JSON', () => {
  const agent = getAgent('claude');
  const payload = {
    session_id: '12345678-1234-1234-1234-123456789abc',
    result: 'Hello world',
    total_cost_usd: 0.0035,
    usage: {
      input_tokens: 1500,
      output_tokens: 200,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 800,
    },
  };
  const parsed = agent.parseOutput(JSON.stringify(payload));
  assert.equal(parsed.text, 'Hello world');
  assert.equal(parsed.threadId, '12345678-1234-1234-1234-123456789abc');
  assert.ok(parsed.usage);
  assert.equal(parsed.usage.inputTokens, 1500);
  assert.equal(parsed.usage.outputTokens, 200);
  assert.equal(parsed.usage.cacheCreationTokens, 100);
  assert.equal(parsed.usage.cacheReadTokens, 800);
  assert.equal(parsed.costUsd, 0.0035);
});

test('claude parseOutput returns undefined usage when not present', () => {
  const agent = getAgent('claude');
  const payload = {
    session_id: '12345678-1234-1234-1234-123456789abc',
    result: 'No usage data',
  };
  const parsed = agent.parseOutput(JSON.stringify(payload));
  assert.equal(parsed.text, 'No usage data');
  assert.equal(parsed.usage, undefined);
  assert.equal(parsed.costUsd, undefined);
});

