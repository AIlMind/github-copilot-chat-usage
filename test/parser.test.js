const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseEntries,
  parseChatSessionLog,
  formatAic,
  formatDuration,
  isSystemContinuation,
} = require('../out/parser');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  assert.strictEqual(actual, expected, message);
}

function makeEntry(data) {
  return {
    sid: 'test-session-id',
    dur: 0,
    status: 'ok',
    name: data.name || data.type,
    attrs: {},
    ...data,
    attrs: { ...(data.attrs || {}) },
  };
}

test('isSystemContinuation - identifies terminal notifications', () => {
  assert(isSystemContinuation('[Terminal abc notification: command completed]'), 'terminal notification');
  assert(isSystemContinuation('[Notification: something happened]'), 'notification');
  assert(isSystemContinuation('[Background terminal xyz]'), 'background terminal');
  assert(!isSystemContinuation('Can you help me with this?'), 'real user message');
  assert(!isSystemContinuation(''), 'empty string');
  assert(!isSystemContinuation('[Something else]'), 'other bracket');
});

test('parseEntries - returns undefined for empty array', () => {
  assertEqual(parseEntries([]), undefined, 'empty entries returns undefined');
});

test('parseEntries - basic single user message with one LLM turn', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: { content: 'Hello world' } }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'msg-1',
      dur: 500,
      attrs: {
        model: 'claude-opus-4.6',
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 20,
        copilotUsageNanoAiu: 5000000000,
      },
    }),
  ];

  const result = parseEntries(entries);

  assert(result !== undefined, 'result should not be undefined');
  assertEqual(result.sessionId, 'test-session-id', 'session ID');
  assertEqual(result.userMessages.length, 1, 'one user message');
  assertEqual(result.modelTurnCount, 1, 'one model turn');
  assertEqual(result.totalInputTokens, 100, 'total input tokens');
  assertEqual(result.totalOutputTokens, 50, 'total output tokens');
  assertEqual(result.totalCachedTokens, 20, 'total cached tokens');
  assertEqual(result.totalNanoAiu, 5000000000, 'total nanoAiu');

  const msg = result.userMessages[0];
  assertEqual(msg.content, 'Hello world', 'message content');
  assertEqual(msg.modelTurns.length, 1, 'one model turn in message');
  assertEqual(msg.modelTurns[0].model, 'claude-opus-4.6', 'model name');
});

test('parseEntries - tool calls assigned to correct turns', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: { content: 'Do something' } }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'msg-1',
      dur: 300,
      attrs: {
        model: 'gpt-4',
        inputTokens: 50,
        outputTokens: 20,
        cachedTokens: 0,
        copilotUsageNanoAiu: 1000000000,
      },
    }),
    makeEntry({ type: 'tool_call', ts: 1200, spanId: 'tool-1', parentSpanId: 'msg-1', name: 'read_file', dur: 400 }),
    makeEntry({ type: 'tool_call', ts: 1300, spanId: 'tool-2', parentSpanId: 'msg-1', name: 'grep_search', dur: 80 }),
    makeEntry({
      type: 'llm_request',
      ts: 1400,
      spanId: 'llm-2',
      parentSpanId: 'msg-1',
      dur: 400,
      attrs: {
        model: 'gpt-4',
        inputTokens: 150,
        outputTokens: 30,
        cachedTokens: 50,
        copilotUsageNanoAiu: 2000000000,
      },
    }),
    makeEntry({ type: 'tool_call', ts: 1500, spanId: 'tool-3', parentSpanId: 'msg-1', name: 'run_in_terminal', dur: 200 }),
  ];

  const result = parseEntries(entries);
  const msg = result.userMessages[0];

  assertEqual(msg.modelTurns.length, 2, 'two model turns');
  assertEqual(msg.toolCalls.length, 3, 'three total tool calls');

  assertEqual(msg.modelTurns[0].toolCalls.length, 2, 'turn 1 has 2 tools');
  assertEqual(msg.modelTurns[0].toolCalls[0].name, 'read_file', 'turn 1 tool 1 is read_file');
  assertEqual(msg.modelTurns[0].toolCalls[1].name, 'grep_search', 'turn 1 tool 2 is grep_search');

  assertEqual(msg.modelTurns[1].toolCalls.length, 1, 'turn 2 has 1 tool');
  assertEqual(msg.modelTurns[1].toolCalls[0].name, 'run_in_terminal', 'turn 2 tool is run_in_terminal');
});

test('parseEntries - pre-turn tool calls assigned to first turn', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: { content: 'hello' } }),
    makeEntry({ type: 'tool_call', ts: 1050, spanId: 'tool-0', parentSpanId: 'msg-1', name: 'early_tool', dur: 10 }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'msg-1',
      dur: 200,
      attrs: {
        model: 'gpt-4',
        inputTokens: 50,
        outputTokens: 10,
        cachedTokens: 0,
        copilotUsageNanoAiu: 500000000,
      },
    }),
  ];

  const result = parseEntries(entries);
  const msg = result.userMessages[0];

  assertEqual(msg.modelTurns[0].toolCalls.length, 1, 'pre-turn tool assigned to turn 1');
  assertEqual(msg.modelTurns[0].toolCalls[0].name, 'early_tool', 'correct tool name');
});

test('parseEntries - system continuations merged into previous message', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: { content: 'Write some code' } }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'msg-1',
      dur: 500,
      attrs: {
        model: 'claude-opus-4.6',
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        copilotUsageNanoAiu: 3000000000,
      },
    }),
    makeEntry({ type: 'user_message', ts: 2000, spanId: 'msg-2', attrs: { content: '[Terminal abc notification: command completed with exit code 0]' } }),
    makeEntry({
      type: 'llm_request',
      ts: 2100,
      spanId: 'llm-2',
      parentSpanId: 'msg-2',
      dur: 400,
      attrs: {
        model: 'claude-opus-4.6',
        inputTokens: 200,
        outputTokens: 30,
        cachedTokens: 100,
        copilotUsageNanoAiu: 2000000000,
      },
    }),
  ];

  const result = parseEntries(entries);

  assertEqual(result.userMessages.length, 1, 'merged into 1 message');
  assertEqual(result.userMessages[0].content, 'Write some code', 'primary message content preserved');
  assertEqual(result.userMessages[0].mergedMessages.length, 1, 'merged message present');
  assertEqual(result.userMessages[0].modelTurns.length, 2, 'both turns present');
});

test('parseEntries - handles missing fields gracefully', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: {} }),
    makeEntry({ type: 'llm_request', ts: 1100, spanId: 'llm-1', parentSpanId: 'msg-1', attrs: {} }),
  ];

  const result = parseEntries(entries);

  assert(result !== undefined, 'handles missing fields');
  assertEqual(result.totalInputTokens, 0, 'defaults to 0');
  assertEqual(result.totalOutputTokens, 0, 'defaults to 0');
  assertEqual(result.totalNanoAiu, 0, 'defaults to 0');
});

test('parseEntries - content preview truncated at 80 chars', () => {
  const longContent = 'A'.repeat(200);
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: { content: longContent } }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'msg-1',
      dur: 100,
      attrs: {
        model: 'gpt-4',
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        copilotUsageNanoAiu: 100000000,
      },
    }),
  ];

  const result = parseEntries(entries);
  assertEqual(result.userMessages[0].content.length, 80, 'content truncated to 80');
});

test('formatAic - converts nanoAiu to AIC string', () => {
  assertEqual(formatAic(1000000000), '1.00', '1 AIC');
  assertEqual(formatAic(5500000000), '5.50', '5.5 AIC');
  assertEqual(formatAic(0), '0.00', '0 AIC');
  assertEqual(formatAic(123456789), '0.12', 'fractional AIC');
});

test('formatDuration - formats milliseconds', () => {
  assertEqual(formatDuration(500), '500ms', 'under 1s');
  assertEqual(formatDuration(1500), '1.5s', 'over 1s');
  assertEqual(formatDuration(10000), '10.0s', '10s');
  assertEqual(formatDuration(100), '100ms', '100ms');
});

test('parseEntries - multiple continuations all merge into one', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: { content: 'Do work' } }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'msg-1',
      dur: 200,
      attrs: {
        model: 'gpt-4',
        inputTokens: 50,
        outputTokens: 20,
        cachedTokens: 0,
        copilotUsageNanoAiu: 1000000000,
      },
    }),
    makeEntry({ type: 'user_message', ts: 2000, spanId: 'msg-2', attrs: { content: '[Terminal abc notification done]' } }),
    makeEntry({
      type: 'llm_request',
      ts: 2100,
      spanId: 'llm-2',
      parentSpanId: 'msg-2',
      dur: 100,
      attrs: {
        model: 'gpt-4',
        inputTokens: 60,
        outputTokens: 10,
        cachedTokens: 50,
        copilotUsageNanoAiu: 500000000,
      },
    }),
    makeEntry({ type: 'user_message', ts: 3000, spanId: 'msg-3', attrs: { content: '[Background terminal finished]' } }),
    makeEntry({
      type: 'llm_request',
      ts: 3100,
      spanId: 'llm-3',
      parentSpanId: 'msg-3',
      dur: 150,
      attrs: {
        model: 'gpt-4',
        inputTokens: 70,
        outputTokens: 15,
        cachedTokens: 60,
        copilotUsageNanoAiu: 500000000,
      },
    }),
  ];

  const result = parseEntries(entries);

  assertEqual(result.userMessages.length, 1, 'all merged into one');
  assertEqual(result.userMessages[0].mergedMessages.length, 2, 'two continuations merged');
  assertEqual(result.userMessages[0].modelTurns.length, 3, 'all three turns present');
  assertEqual(result.totalInputTokens, 180, 'all tokens summed');
});

test('parseEntries - first message as system continuation is NOT merged (no prev)', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: { content: '[Terminal xyz notification: started]' } }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'msg-1',
      dur: 200,
      attrs: {
        model: 'gpt-4',
        inputTokens: 50,
        outputTokens: 20,
        cachedTokens: 0,
        copilotUsageNanoAiu: 1000000000,
      },
    }),
  ];

  const result = parseEntries(entries);

  assertEqual(result.userMessages.length, 1, 'stays as one message');
  assertEqual(result.userMessages[0].mergedMessages.length, 0, 'no merges');
});

test('parseEntries - recycled spanIds do not cause duplicate grouping', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'span-A', attrs: { content: 'First' } }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'span-A',
      dur: 200,
      attrs: {
        model: 'gpt-4',
        inputTokens: 50,
        outputTokens: 20,
        cachedTokens: 40,
        copilotUsageNanoAiu: 1000000000,
      },
    }),

    makeEntry({ type: 'user_message', ts: 2000, spanId: 'span-A', attrs: { content: 'Second' } }),
    makeEntry({
      type: 'llm_request',
      ts: 2100,
      spanId: 'llm-2',
      parentSpanId: 'span-A',
      dur: 300,
      attrs: {
        model: 'gpt-4',
        inputTokens: 80,
        outputTokens: 30,
        cachedTokens: 60,
        copilotUsageNanoAiu: 2000000000,
      },
    }),

    makeEntry({ type: 'user_message', ts: 3000, spanId: 'span-A', attrs: { content: 'Third' } }),
    makeEntry({
      type: 'llm_request',
      ts: 3100,
      spanId: 'llm-3',
      parentSpanId: 'span-A',
      dur: 100,
      attrs: {
        model: 'gpt-4',
        inputTokens: 90,
        outputTokens: 10,
        cachedTokens: 80,
        copilotUsageNanoAiu: 500000000,
      },
    }),
  ];

  const result = parseEntries(entries);

  assertEqual(result.userMessages.length, 3, 'three separate messages despite same spanId');
  assertEqual(result.userMessages[0].modelTurns.length, 1, 'msg 1: one turn');
  assertEqual(result.userMessages[1].modelTurns.length, 1, 'msg 2: one turn');
  assertEqual(result.userMessages[2].modelTurns.length, 1, 'msg 3: one turn');
  assertEqual(result.userMessages[0].totalNanoAiu, 1000000000, 'msg 1: correct cost');
  assertEqual(result.userMessages[1].totalNanoAiu, 2000000000, 'msg 2: correct cost');
  assertEqual(result.userMessages[2].totalNanoAiu, 500000000, 'msg 3: correct cost');
});

test('parseEntries - cache ratio fields are computed correctly', () => {
  const entries = [
    makeEntry({ type: 'user_message', ts: 1000, spanId: 'msg-1', attrs: { content: 'hello' } }),
    makeEntry({
      type: 'llm_request',
      ts: 1100,
      spanId: 'llm-1',
      parentSpanId: 'msg-1',
      dur: 100,
      attrs: {
        model: 'gpt-4',
        inputTokens: 1000,
        outputTokens: 50,
        cachedTokens: 800,
        copilotUsageNanoAiu: 500000000,
      },
    }),
    makeEntry({
      type: 'llm_request',
      ts: 1200,
      spanId: 'llm-2',
      parentSpanId: 'msg-1',
      dur: 100,
      attrs: {
        model: 'gpt-4',
        inputTokens: 2000,
        outputTokens: 100,
        cachedTokens: 0,
        copilotUsageNanoAiu: 1000000000,
      },
    }),
  ];

  const result = parseEntries(entries);
  const turns = result.userMessages[0].modelTurns;

  assertEqual(turns[0].cacheHitRatio, 0.8, 'turn 1 cache ratio');
  assertEqual(turns[0].freshTokens, 200, 'turn 1 fresh tokens');

  assertEqual(turns[1].cacheHitRatio, 0, 'turn 2 cache ratio');
  assertEqual(turns[1].freshTokens, 2000, 'turn 2 fresh tokens');
});

test('parseChatSessionLog - reconstructs VS Code chatSessions patches', () => {
  const fixture = path.join(__dirname, 'fixtures', 'sample-chat-session.jsonl');
  const result = parseChatSessionLog(fixture);

  assert(result !== undefined, 'result should not be undefined');
  assertEqual(result.sessionId, 'sample-chat-session', 'session ID');
  assertEqual(result.title, 'Enable chat debug view steps', 'custom title');
  assertEqual(result.userMessages.length, 2, 'two user messages from appended request patches');
  assertEqual(result.userMessages[0].content, 'Enable chat debug view steps', 'message content');
  assertEqual(result.userMessages[1].content, 'Can you tell me how the code works?', 'follow-up message content');
  assertEqual(result.modelTurnCount, 1, 'one model turn');
  assertEqual(result.totalOutputTokens, 42, 'completion tokens');
  assertEqual(result.totalDurationMs, 1234, 'elapsed time');
  assertEqual(result.toolCallCount, 1, 'one tool call');
  assertEqual(result.userMessages[0].modelTurns[0].toolCalls[0].name, 'findTextInFiles', 'normalized tool name');
  assertEqual(result.userMessages[0].modelTurns[0].toolCalls[0].displayLabel, 'Searched files', 'tool label');
  assertEqual(result.userMessages[0].modelTurns[0].toolCalls[0].toolKind, 'search', 'tool kind');
});

test('parseChatSessionLog - parses credit details but ignores multiplier details', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const fixture = path.join(tmpDir, 'chat-credit-details.jsonl');
  const state = {
    version: 3,
    creationDate: 1000,
    sessionId: 'chat-credit-details',
    requests: [
      {
        requestId: 'request-1',
        timestamp: 1000,
        message: 'Use credits',
        agent: { name: 'agent' },
        modelId: 'copilot/auto',
        response: [],
        completionTokens: 10,
        elapsedMs: 100,
        result: {
          details: 'Claude Haiku 4.5 • 2.3 credits',
          metadata: { promptTokens: 100 },
        },
      },
      {
        requestId: 'request-2',
        timestamp: 2000,
        message: 'Use multiplier',
        agent: { name: 'agent' },
        modelId: 'copilot/auto',
        response: [],
        completionTokens: 5,
        elapsedMs: 50,
        result: {
          details: 'Claude Opus 4.7 • 7.5x',
          metadata: { promptTokens: 50 },
        },
      },
    ],
  };

  try {
    fs.writeFileSync(fixture, JSON.stringify({ kind: 0, v: state }) + '\n');
    const result = parseChatSessionLog(fixture);

    assert(result !== undefined, 'result should not be undefined');
    assertEqual(result.sourceType, 'chatSession', 'source type');
    assertEqual(result.modelTurnCount, 2, 'two model turns');
    assertEqual(result.totalNanoAiu, 2300000000, 'only credit details become AIC');
    assertEqual(result.totalTokens, 165, 'token totals still parse');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed! √');
}
