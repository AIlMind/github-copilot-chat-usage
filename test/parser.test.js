const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseEntries,
  parseDebugLog,
  parseChatSessionLog,
  formatAic,
  formatDuration,
  isSystemContinuation,
} = require('../out/parser');
const {
  computeSpendSummaryFromChatSessionDirs,
  readSpendRequestsFromChatSession,
} = require('../out/spend');
const { SessionGraph } = require('../out/graph');

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

function makeSpendRequest({ timestamp, credits = 1, inputTokens = 10, outputTokens = 2, details, nanoAiu }) {
  const usage = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
  if (nanoAiu !== undefined) {
    usage.nanoAiu = nanoAiu;
  }

  return {
    requestId: `request-${timestamp}`,
    timestamp,
    modelId: 'copilot/gpt-5-mini',
    result: {
      details: details ?? `GPT-5 mini \u2022 ${credits} credits`,
      metadata: {
        usage,
      },
    },
  };
}

function writeSpendSession(filePath, request) {
  fs.writeFileSync(filePath, [
    JSON.stringify({ kind: 0, v: { sessionId: path.basename(filePath, '.jsonl'), requests: [] } }),
    JSON.stringify({ kind: 2, k: ['requests'], v: [request] }),
    '',
  ].join('\n'));
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

test('parseChatSessionLog - appends request patches without explicit index', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const fixture = path.join(tmpDir, 'chat-append-no-index.jsonl');
  const firstRequest = {
    requestId: 'request-1',
    timestamp: 1000,
    message: 'First message',
    response: [],
    completionTokens: 1,
    result: { details: 'GPT-5 mini • 1 credits' },
  };
  const secondRequest = {
    requestId: 'request-2',
    timestamp: 2000,
    message: 'Second message',
    response: [],
    completionTokens: 2,
    result: { details: 'GPT-5 mini • 2 credits' },
  };

  try {
    fs.writeFileSync(fixture, [
      JSON.stringify({ kind: 0, v: { sessionId: 'chat-append-no-index', creationDate: 1000, requests: [firstRequest] } }),
      JSON.stringify({ kind: 2, k: ['requests'], v: [secondRequest] }),
      '',
    ].join('\n'));

    const result = parseChatSessionLog(fixture);

    assert(result !== undefined, 'result should not be undefined');
    assertEqual(result.userMessages.length, 2, 'append without index should not overwrite first request');
    assertEqual(result.userMessages[0].content, 'First message', 'first request preserved');
    assertEqual(result.userMessages[1].content, 'Second message', 'second request appended');
    assertEqual(result.totalNanoAiu, 3000000000, 'both appended request costs counted');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

test('parseChatSessionLog - parses snake_case usage token fields', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const fixture = path.join(tmpDir, 'chat-snake-usage.jsonl');
  const state = {
    version: 3,
    creationDate: 1000,
    sessionId: 'chat-snake-usage',
    requests: [
      {
        requestId: 'request-1',
        timestamp: 1000,
        message: 'Use snake case tokens',
        agent: { name: 'agent' },
        modelId: 'copilot/gpt-5-mini',
        response: [],
        elapsedMs: 100,
        result: {
          details: 'GPT-5 mini \u2022 2 credits',
          metadata: {
            usage: {
              prompt_tokens: 170279,
              completion_tokens: 3220,
              total_tokens: 173499,
            },
          },
        },
      },
    ],
  };

  try {
    fs.writeFileSync(fixture, JSON.stringify({ kind: 0, v: state }) + '\n');
    const result = parseChatSessionLog(fixture);

    assert(result !== undefined, 'result should not be undefined');
    assertEqual(result.totalInputTokens, 170279, 'snake_case prompt_tokens counted');
    assertEqual(result.totalOutputTokens, 3220, 'snake_case completion_tokens counted');
    assertEqual(result.totalTokens, 173499, 'total tokens from parsed input/output');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readSpendRequestsFromChatSession - parses snake_case usage token fields', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const fixture = path.join(tmpDir, 'spend-snake-usage.jsonl');

  try {
    writeSpendSession(fixture, makeSpendRequest({
      timestamp: 1000,
      credits: 2.5,
      inputTokens: 170279,
      outputTokens: 3220,
    }));

    const requests = readSpendRequestsFromChatSession(fixture);

    assertEqual(requests.length, 1, 'one billed spend request');
    assertEqual(requests[0].inputTokens, 170279, 'snake_case prompt_tokens counted');
    assertEqual(requests[0].outputTokens, 3220, 'snake_case completion_tokens counted');
    assertEqual(requests[0].nanoAiu, 2500000000, 'credit details counted');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readSpendRequestsFromChatSession - parses direct usage nanoAiu fields', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const fixture = path.join(tmpDir, 'spend-direct-nano.jsonl');

  try {
    writeSpendSession(fixture, makeSpendRequest({
      timestamp: 1000,
      details: 'GPT-5 mini',
      nanoAiu: 4200000000,
      inputTokens: 12345,
      outputTokens: 678,
    }));

    const requests = readSpendRequestsFromChatSession(fixture);

    assertEqual(requests.length, 1, 'one spend request');
    assertEqual(requests[0].inputTokens, 12345, 'input tokens counted');
    assertEqual(requests[0].outputTokens, 678, 'output tokens counted');
    assertEqual(requests[0].nanoAiu, 4200000000, 'direct nanoAiu counted');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readSpendRequestsFromChatSession - keeps token-only usage rows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const fixture = path.join(tmpDir, 'spend-token-only.jsonl');

  try {
    writeSpendSession(fixture, makeSpendRequest({
      timestamp: 1000,
      details: 'GPT-5 mini',
      inputTokens: 999,
      outputTokens: 111,
    }));

    const requests = readSpendRequestsFromChatSession(fixture);

    assertEqual(requests.length, 1, 'token-only spend request retained');
    assertEqual(requests[0].inputTokens, 999, 'input tokens counted');
    assertEqual(requests[0].outputTokens, 111, 'output tokens counted');
    assertEqual(requests[0].nanoAiu, 0, 'missing credits stay zero');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computeSpendSummaryFromChatSessionDirs - reuses unchanged central file cache', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const chatDir = path.join(tmpDir, 'chatSessions');
  const fixture = path.join(chatDir, 'spend-cache.jsonl');
  const cacheFile = path.join(tmpDir, 'global', 'spend-file-cache.json');
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const dirs = [{ dir: chatDir, workspaceKey: 'workspace-a', workspaceLabel: 'Workspace A' }];

  try {
    fs.mkdirSync(chatDir, { recursive: true });
    writeSpendSession(fixture, makeSpendRequest({ timestamp: now - 1000, credits: 1, inputTokens: 10, outputTokens: 2 }));

    const first = computeSpendSummaryFromChatSessionDirs('full', dirs, { cacheFilePath: cacheFile, now });
    assertEqual(first.today.nanoAiu, 1000000000, 'initial summary cost');
    assertEqual(first.today.inputTokens, 10, 'initial input tokens');
    assert(fs.existsSync(cacheFile), 'central cache file should be written');

    const originalOpenSync = fs.openSync;
    fs.openSync = function patchedOpenSync(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(fixture)) {
        throw new Error('source should not be reparsed when stat matches cache');
      }
      return originalOpenSync.call(fs, file, ...args);
    };

    try {
      const second = computeSpendSummaryFromChatSessionDirs('full', dirs, { cacheFilePath: cacheFile, now });
      assertEqual(second.today.nanoAiu, 1000000000, 'cached summary cost');
      assertEqual(second.today.inputTokens, 10, 'cached input tokens');
    } finally {
      fs.openSync = originalOpenSync;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computeSpendSummaryFromChatSessionDirs - ignores stale parser-version central file cache', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const chatDir = path.join(tmpDir, 'chatSessions');
  const fixture = path.join(chatDir, 'spend-cache-stale.jsonl');
  const cacheFile = path.join(tmpDir, 'global', 'spend-file-cache.json');
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const dirs = [{ dir: chatDir, workspaceKey: 'workspace-a', workspaceLabel: 'Workspace A' }];

  try {
    fs.mkdirSync(chatDir, { recursive: true });
    writeSpendSession(fixture, makeSpendRequest({ timestamp: now - 1000, credits: 5, inputTokens: 50, outputTokens: 5 }));

    const stat = fs.statSync(fixture);
    const cacheKey = crypto.createHash('sha256').update(path.resolve(fixture)).digest('hex');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      version: 2,
      entries: {
        [cacheKey]: {
          parserVersion: 2,
          path: path.resolve(fixture),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          requests: [{ timestamp: now - 1000, nanoAiu: 1, inputTokens: 1, outputTokens: 1, model: 'stale' }],
          parsedAt: now,
          lastSeenAt: now,
        },
      },
    }));

    const summary = computeSpendSummaryFromChatSessionDirs('full', dirs, { cacheFilePath: cacheFile, now });

    assertEqual(summary.today.nanoAiu, 5000000000, 'stale cache cost ignored');
    assertEqual(summary.today.inputTokens, 50, 'stale cache input tokens ignored');
    assertEqual(summary.today.outputTokens, 5, 'stale cache output tokens ignored');
    assertEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')).version, 3, 'cache rewritten with current parser version');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computeSpendSummaryFromChatSessionDirs - reparses changed cached files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const chatDir = path.join(tmpDir, 'chatSessions');
  const fixture = path.join(chatDir, 'spend-cache-change.jsonl');
  const cacheFile = path.join(tmpDir, 'global', 'spend-file-cache.json');
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const dirs = [{ dir: chatDir, workspaceKey: 'workspace-a', workspaceLabel: 'Workspace A' }];

  try {
    fs.mkdirSync(chatDir, { recursive: true });
    writeSpendSession(fixture, makeSpendRequest({ timestamp: now - 1000, credits: 1, inputTokens: 10, outputTokens: 2 }));
    const first = computeSpendSummaryFromChatSessionDirs('full', dirs, { cacheFilePath: cacheFile, now });
    assertEqual(first.today.nanoAiu, 1000000000, 'initial summary cost');

    writeSpendSession(fixture, makeSpendRequest({ timestamp: now - 1000, credits: 3, inputTokens: 30, outputTokens: 6 }));
    fs.utimesSync(fixture, new Date(now + 10000), new Date(now + 10000));

    const second = computeSpendSummaryFromChatSessionDirs('full', dirs, { cacheFilePath: cacheFile, now });
    assertEqual(second.today.nanoAiu, 3000000000, 'changed file summary cost');
    assertEqual(second.today.inputTokens, 30, 'changed file input tokens');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseDebugLog - matches completed subagent child logs by parent span', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const mainLog = path.join(tmpDir, 'main.jsonl');
  const childA = path.join(tmpDir, 'runSubagent-default-call_a.jsonl');
  const childB = path.join(tmpDir, 'runSubagent-default-call_b.jsonl');
  const writeJsonl = (file, entries) => fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');

  try {
    writeJsonl(childA, [
      makeEntry({ sid: 'child-a', type: 'user_message', ts: 1300, spanId: 'child-a-msg', parentSpanId: 'subagent-a', attrs: { content: 'Child A' } }),
      makeEntry({ sid: 'child-a', type: 'llm_request', ts: 1400, spanId: 'child-a-llm', parentSpanId: 'child-a-msg', attrs: { model: 'gpt-a', inputTokens: 10, outputTokens: 1, copilotUsageNanoAiu: 1000000000 } }),
    ]);
    writeJsonl(childB, [
      makeEntry({ sid: 'child-b', type: 'user_message', ts: 1310, spanId: 'child-b-msg', parentSpanId: 'subagent-b', attrs: { content: 'Child B' } }),
      makeEntry({ sid: 'child-b', type: 'llm_request', ts: 1410, spanId: 'child-b-llm', parentSpanId: 'child-b-msg', attrs: { model: 'gpt-b', inputTokens: 20, outputTokens: 2, copilotUsageNanoAiu: 2000000000 } }),
    ]);
    writeJsonl(mainLog, [
      makeEntry({ sid: 'main', type: 'user_message', ts: 1000, spanId: 'main-msg', attrs: { content: 'Run two subagents' } }),
      makeEntry({ sid: 'main', type: 'llm_request', ts: 1100, spanId: 'main-llm', parentSpanId: 'main-msg', attrs: { model: 'gpt-main', inputTokens: 100, outputTokens: 10, copilotUsageNanoAiu: 500000000 } }),
      makeEntry({ sid: 'main', type: 'tool_call', name: 'runSubagent', ts: 1200, spanId: 'subagent-a', parentSpanId: 'main-llm', attrs: { args: JSON.stringify({ description: 'A' }) } }),
      makeEntry({ sid: 'main', type: 'tool_call', name: 'runSubagent', ts: 1250, spanId: 'subagent-b', parentSpanId: 'main-llm', attrs: { args: JSON.stringify({ description: 'B' }) } }),
      makeEntry({ sid: 'main', type: 'child_session_ref', ts: 1600, spanId: 'ref-b', parentSpanId: 'subagent-b', attrs: { childLogFile: path.basename(childB) } }),
      makeEntry({ sid: 'main', type: 'child_session_ref', ts: 1601, spanId: 'ref-a', parentSpanId: 'subagent-a', attrs: { childLogFile: path.basename(childA) } }),
    ]);

    const result = parseDebugLog(mainLog);
    const calls = result.userMessages[0].modelTurns[0].toolCalls;

    assert(result !== undefined, 'result should not be undefined');
    assertEqual(calls[0].spanId, 'subagent-a', 'first subagent span');
    assertEqual(calls[0].subagentSummary.totalNanoAiu, 1000000000, 'child A attached to subagent A');
    assertEqual(calls[1].spanId, 'subagent-b', 'second subagent span');
    assertEqual(calls[1].subagentSummary.totalNanoAiu, 2000000000, 'child B attached to subagent B');
    assertEqual(result.totalNanoAiu, 3500000000, 'parent total rolls up both children once');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SessionGraph - serializes nested subagent messages and turns', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const mainLog = path.join(tmpDir, 'main.jsonl');
  const child = path.join(tmpDir, 'runSubagent-default-call_child.jsonl');
  const writeJsonl = (file, entries) => fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');

  try {
    writeJsonl(child, [
      makeEntry({ sid: 'child', type: 'user_message', ts: 1300, spanId: 'child-msg', parentSpanId: 'subagent-child', attrs: { content: 'Inspect nested files' } }),
      makeEntry({ sid: 'child', type: 'llm_request', ts: 1400, spanId: 'child-llm', parentSpanId: 'child-msg', attrs: { model: 'gpt-child', debugName: 'child-turn', inputTokens: 42, outputTokens: 7, copilotUsageNanoAiu: 1200000000 } }),
      makeEntry({ sid: 'child', type: 'tool_call', name: 'read_file', ts: 1450, spanId: 'child-tool', parentSpanId: 'child-llm', attrs: { args: JSON.stringify({ filePath: '/tmp/nested.txt' }) } }),
      makeEntry({ sid: 'child', type: 'tool_call', name: 'run_in_terminal', ts: 1460, spanId: 'child-terminal', parentSpanId: 'child-llm', attrs: { args: JSON.stringify({ command: 'git status --short' }) } }),
    ]);
    writeJsonl(mainLog, [
      makeEntry({ sid: 'main-graph', type: 'user_message', ts: 1000, spanId: 'main-msg', attrs: { content: 'Run nested subagent' } }),
      makeEntry({ sid: 'main-graph', type: 'llm_request', ts: 1100, spanId: 'main-llm', parentSpanId: 'main-msg', attrs: { model: 'gpt-main', debugName: 'main-turn', inputTokens: 100, outputTokens: 10, copilotUsageNanoAiu: 500000000 } }),
      makeEntry({ sid: 'main-graph', type: 'tool_call', name: 'runSubagent', ts: 1200, spanId: 'subagent-child', parentSpanId: 'main-llm', attrs: { args: JSON.stringify({ description: 'Nested inspector' }) } }),
      makeEntry({ sid: 'main-graph', type: 'child_session_ref', ts: 1600, spanId: 'ref-child', parentSpanId: 'subagent-child', attrs: { childLogFile: path.basename(child) } }),
    ]);

    const summary = parseDebugLog(mainLog);
    assert(summary !== undefined, 'result should not be undefined');

    const graph = new SessionGraph(summary);
    const subagent = graph.messages[0].turns[0].toolCalls[0].subagent;
    const serialized = graph.serialize({ includeMessages: true, maxMessages: 5 });

    assert(subagent, 'graph tool call should include nested subagent graph');
    assertEqual(subagent.messages[0].content, 'Inspect nested files', 'nested subagent message retained');
    assertEqual(subagent.messages[0].turns[0].debugName, 'child-turn', 'nested subagent turn retained');
    assertEqual(subagent.toolCallCount, 2, 'subagent tool count includes child tools');
    assertEqual(graph.stats.toolCallCount, 3, 'session tool count includes nested child tools');
    assertEqual(graph.messages[0].toolCallCount, 3, 'message tool count includes nested child tools');
    assertEqual(graph.toolUsage.get('runSubagent').count, 1, 'parent subagent tool counted');
    assertEqual(graph.toolUsage.get('read_file').count, 1, 'nested read_file tool counted');
    assertEqual(graph.toolUsage.get('run_in_terminal').count, 1, 'nested terminal tool counted');
    assertEqual(graph.commands[0].executable, 'git', 'nested command executable counted');
    assertEqual(graph.commands[0].count, 1, 'nested command count included');
    assert(serialized.includes('## Tool Usage (including subagents)'), 'serialized graph marks recursive tool usage');
    assert(serialized.includes('## Commands (including subagents)'), 'serialized graph marks recursive commands');
    assert(serialized.includes('Subagent: Nested inspector'), 'serialized graph includes subagent section');
    assert(serialized.includes('Message 1: "Inspect nested files"'), 'serialized graph includes child message');
    assert(serialized.includes('Turn 1: child-turn'), 'serialized graph includes child turn');
    assert(serialized.includes('Read: nested.txt'), 'serialized graph includes child tool call');
    assert(serialized.includes('Ran: git status --short'), 'serialized graph includes child terminal tool call');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseDebugLog - matches in-progress orphan subagent by child parent span', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-parser-'));
  const mainLog = path.join(tmpDir, 'main.jsonl');
  const child = path.join(tmpDir, 'runSubagent-default-call_live.jsonl');
  const writeJsonl = (file, entries) => fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');

  try {
    writeJsonl(child, [
      makeEntry({ sid: 'child-live', type: 'user_message', ts: 1300, spanId: 'child-live-msg', parentSpanId: 'subagent-b', attrs: { content: 'Live child' } }),
      makeEntry({ sid: 'child-live', type: 'llm_request', ts: 1400, spanId: 'child-live-llm', parentSpanId: 'child-live-msg', attrs: { model: 'gpt-live', inputTokens: 30, outputTokens: 3, copilotUsageNanoAiu: 3000000000 } }),
    ]);
    writeJsonl(mainLog, [
      makeEntry({ sid: 'main-live', type: 'user_message', ts: 1000, spanId: 'main-live-msg', attrs: { content: 'Run two live subagents' } }),
      makeEntry({ sid: 'main-live', type: 'llm_request', ts: 1100, spanId: 'main-live-llm', parentSpanId: 'main-live-msg', attrs: { model: 'gpt-main', inputTokens: 100, outputTokens: 10, copilotUsageNanoAiu: 500000000 } }),
      makeEntry({ sid: 'main-live', type: 'tool_call', name: 'runSubagent', ts: 1200, spanId: 'subagent-a', parentSpanId: 'main-live-llm', attrs: { args: JSON.stringify({ description: 'A' }) } }),
      makeEntry({ sid: 'main-live', type: 'tool_call', name: 'runSubagent', ts: 1250, spanId: 'subagent-b', parentSpanId: 'main-live-llm', attrs: { args: JSON.stringify({ description: 'B' }) } }),
    ]);

    const result = parseDebugLog(mainLog);
    const calls = result.userMessages[0].modelTurns[0].toolCalls;

    assert(result !== undefined, 'result should not be undefined');
    assertEqual(calls[0].subagentSummary, undefined, 'unmatched subagent stays unattached');
    assertEqual(calls[1].subagentInProgress, true, 'matched subagent is marked in progress');
    assertEqual(calls[1].subagentSummary.totalNanoAiu, 3000000000, 'live child attaches to matching span');
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
