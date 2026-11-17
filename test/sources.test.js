const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { discoverUsageDirectories } = require('../out/discovery');
const { readBackgroundSession } = require('../out/background');
const { parseCopilotSessionFile, parseDebugLog, readEntriesIncremental, setBackgroundCliRoots } = require('../out/parser');
const { readSpendRequestsFromChatSession, computeSpendSummaryFromChatSessionDirs, usageFileSignature } = require('../out/spend');
const now = new Date(2026, 10, 15, 12).getTime();
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sources-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function write(file, values) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, values.map(v => JSON.stringify(v)).join('\n') + '\n'); return file; }
function log(type, ts, spanId, attrs = {}, extra = {}) { return { sid: 'session', type, ts, spanId, dur: 0, name: type, attrs, ...extra }; }
function usageFile(file, kind = 'debug', sessionId = 'session') { return { file, dir: path.dirname(file), workspaceKey: 'workspace', workspaceLabel: 'Workspace', sessionId, kind }; }
function database(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE turns (id TEXT PRIMARY KEY, event_id TEXT); CREATE TABLE turn_usage(turn_id TEXT PRIMARY KEY, usage TEXT); CREATE TABLE session_metadata(key TEXT PRIMARY KEY,value TEXT)');
  for (const [id, event, usage] of rows) { db.prepare('INSERT INTO turns VALUES (?, ?)').run(id, event); db.prepare('INSERT INTO turn_usage VALUES (?, ?)').run(id, JSON.stringify(usage)); }
  db.close(); return file;
}
function persisted(input = 100, cost = 1500000000) { return { inputTokens: 7, outputTokens: 2, model: 'model', _meta: { turnTokenTotals: [{ model: 'model', inputTokens: input, outputTokens: 20, cachedTokens: 60 }], directTurnTokenTotals: [{ model: 'model', inputTokens: 40, outputTokens: 8, cachedTokens: 0 }], copilotUsage: { totalNanoAiu: cost } } }; }

test('discovery probes active custom user data, profiles, both extension-id cases and background stores', t => {
 const root = fixture(t), user = path.join(root, 'custom', 'User');
 const paths = [
  ['debug', path.join(user, 'workspaceStorage/ws/GitHub.copilot-chat/debug-logs')],
  ['debug', path.join(user, 'globalStorage/github.copilot-chat/debug-logs')],
  ['chat', path.join(user, 'globalStorage/emptyWindowChatSessions')],
  ['chat', path.join(user, 'profiles/profile/workspaceStorage/ws/chatSessions')],
  ['agent', path.join(root, 'custom/agentSessionData')],
 ];
 paths.forEach(([, p]) => fs.mkdirSync(p, { recursive: true }));
 const d = discoverUsageDirectories({ defaults: false, globalStoragePath: path.join(user, 'globalStorage/extension') });
 paths.forEach(([kind, p]) => assert(d[kind].includes(fs.realpathSync(p)), p));
});

test('configured roots accept session-state and deduplicate aliases without walking symlinks', t => {
 const root = fixture(t), store = path.join(root, 'session-state'); fs.mkdirSync(store);
 fs.symlinkSync(store, path.join(root, 'alias'));
 const d = discoverUsageDirectories({ defaults: false, searchRoots: [root, store, store], maxDepth: 2 });
 assert.deepEqual(d.cli, [fs.realpathSync(store)]);
});

test('background database uses whole-turn token totals once, not context or direct totals', t => {
 const root = fixture(t), file = database(path.join(root, 'agent/session/session.db'), [['turn', 'event', persisted()]]);
 const cli = path.join(root, 'cli'); write(path.join(cli, 'session/events.jsonl'), [{ id: 'event', type: 'user.message', timestamp: new Date(now - 1000).toISOString(), data: { content: 'test' } }]);
 const data = readBackgroundSession(file, [cli]);
 assert.equal(data.usage.length, 1); assert.equal(data.usage[0].inputTokens, 100); assert.equal(data.usage[0].nanoAiu, 1500000000); assert.equal(data.usage[0].timestamp, now - 1000);
 setBackgroundCliRoots([cli], [path.join(root, 'agent')]);
 const s = parseCopilotSessionFile(file).summary;
 assert.equal(s.totalInputTokens, 100); assert.equal(s.totalOutputTokens, 20); assert.equal(s.totalCachedTokens, 60); assert.equal(s.totalNanoAiu, 1500000000);
 assert.equal(parseCopilotSessionFile(path.join(cli, 'session/events.jsonl')).summary.totalNanoAiu, s.totalNanoAiu);
 setBackgroundCliRoots([]);
});

test('saved usage without token totals does not add context-window values to consumption', t => {
 const root = fixture(t), file = database(path.join(root, 'session/session.db'), [['turn', null, { inputTokens: 99999, _meta: { copilotUsage: { totalNanoAiu: 0 } } }]]);
 const data = readBackgroundSession(file);
 assert.equal(data.usage[0].inputTokens, 0); assert.equal(data.usage[0].nanoAiu, 0); assert(data.notes.some(n => n.includes('context-window')));
});

test('undated turns remain individually inspectable and are excluded from dated spend', t => {
 const root = fixture(t), file = database(path.join(root, 'session/session.db'), [['a', null, persisted()], ['b', null, persisted(200, 2000000000)]]);
 const s = parseCopilotSessionFile(file).summary; assert.equal(s.userMessages.length, 2); assert.equal(s.totalInputTokens, 300); assert.equal(s.totalNanoAiu, 3500000000);
 const spend = computeSpendSummaryFromChatSessionDirs('full', [], { now, usageFiles: [usageFile(file, 'background')] });
 assert.equal(spend.today.nanoAiu, 0); assert.equal(spend.month.nanoAiu, 0); assert.equal(spend.undatedRequests, 2);
});

test('backend session credit total is preferred and partial status is preserved', t => {
 const root = fixture(t), u = persisted(); u._meta.copilotUsage.sessionTotalNanoAiu = 1800000000; u._meta.copilotUsage.sessionAiCreditsStatus = 'partial';
 const file = database(path.join(root, 'session/session.db'), [['a', null, u]]);
 const s = parseCopilotSessionFile(file).summary; assert.equal(s.totalNanoAiu, 1800000000); assert(s.usageNotes.some(n => n.includes('incomplete'))); assert(s.usageNotes.some(n => n.includes('cannot be assigned')));
});

test('empty and corrupt agent stores explain missing usage', t => {
 const root = fixture(t), file = database(path.join(root, 'session/session.db'), []);
 const s = parseCopilotSessionFile(file).summary; assert(s.usageNotes.some(n => n.includes('zero totals do not mean')));
 const bad = path.join(root, 'bad/session.db'); fs.mkdirSync(path.dirname(bad)); fs.writeFileSync(bad, 'not sqlite');
 assert(readBackgroundSession(bad).notes.some(n => n.includes('unavailable')));
});

test('legacy CLI credits map by SDK event id and do not pretend to contain tokens', t => {
 const root = fixture(t), file = write(path.join(root, 'session/events.jsonl'), [{ id: 'event', type: 'user.message', timestamp: new Date(now - 1000).toISOString(), data: { content: 'test' } }]);
 fs.writeFileSync(path.join(path.dirname(file), 'vscode.requests.metadata.json'), JSON.stringify([{ vscodeRequestId: 'vscode', copilotRequestId: 'event', creditsUsed: 1.23456789, responseModelId: 'model' }]));
 const s = parseCopilotSessionFile(file).summary; assert.equal(s.totalNanoAiu, 1234567890); assert.equal(s.totalInputTokens, 0);
});

test('duplicate SDK events are counted once and tool completion is paired by toolCallId', t => {
 const root = fixture(t), user = { id: 'user', type: 'user.message', timestamp: new Date(now - 1000).toISOString(), data: { content: 'test' } };
 const usage = { id: 'usage', type: 'assistant.usage', timestamp: new Date(now - 500).toISOString(), data: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, model: 'model', copilotUsage: { totalNanoAiu: 100 } } };
 const file = write(path.join(root, 'session/events.jsonl'), [user, user, { id: 'start', type: 'tool.execution_start', timestamp: new Date(now - 700).toISOString(), data: { toolCallId: 'tool', toolName: 'bash' } }, usage, usage, { id: 'end', type: 'tool.execution_complete', timestamp: new Date(now - 600).toISOString(), data: { toolCallId: 'tool', success: true } }]);
 const s = parseCopilotSessionFile(file).summary; assert.equal(s.userMessages.length, 1); assert.equal(s.totalInputTokens, 100); assert.equal(s.totalNanoAiu, 100); assert.equal(s.userMessages[0].toolCalls[0].durationMs, 100);
});

test('cumulative debug totals replace rounded transcript values without deduplicating model calls by responseId', t => {
 const root = fixture(t), ts = now - 1000;
 const file = write(path.join(root, 'debug/session/main.jsonl'), [log('user_message', ts, 'user', { content: 'test' }), log('llm_request', ts + 1, 'a', { model: 'model', responseId: 'response', inputTokens: 100, outputTokens: 4, copilotUsageNanoAiu: 123456789 }), log('llm_request', ts + 2, 'b', { model: 'model', responseId: 'response', inputTokens: 200, outputTokens: 6, copilotUsageNanoAiu: 234567890 })]);
 const chat = path.join(root, 'chatSessions');
 write(path.join(chat, 'session.jsonl'), [{ kind: 0, v: { requests: [{ timestamp: ts, promptTokens: 200, completionTokens: 10, result: { details: 'model • 0.4 credits', metadata: { responseId: 'response' } } }] } }]);
 const s = computeSpendSummaryFromChatSessionDirs('full', [{ dir: chat, workspaceKey: 'workspace', workspaceLabel: 'Workspace' }], { now, usageFiles: [usageFile(file)] });
 assert.equal(s.today.nanoAiu, 358024679); assert.equal(s.today.inputTokens, 300); assert.equal(s.today.outputTokens, 10); assert.equal(s.today.requestCount, 1); assert.equal(s.today.sessionCount, 1);
});

test('one background representation is selected over duplicate debug and transcript roots', t => {
 const root = fixture(t), cli = path.join(root, 'cli');
 const db = database(path.join(root, 'agent/session/session.db'), [['turn', 'event', persisted()]]);
 const events = write(path.join(cli, 'session/events.jsonl'), [{ id: 'event', type: 'user.message', timestamp: new Date(now - 1000).toISOString(), data: { content: 'test' } }]);
 const debug = write(path.join(root, 'debug/session/main.jsonl'), [log('user_message', now - 1000, 'u', { content: 'test' }), log('llm_request', now - 999, 'l', { inputTokens: 100, outputTokens: 20, copilotUsageNanoAiu: 1500000000 })]);
 const s = computeSpendSummaryFromChatSessionDirs('full', [], { now, cliRoots: [cli], agentRoots: [path.join(root, 'agent')], usageFiles: [usageFile(debug), usageFile(events, 'background'), usageFile(db, 'background')] });
 assert.equal(s.today.nanoAiu, 1500000000); assert.equal(s.today.inputTokens, 100); assert.equal(s.today.requestCount, 1);
});

test('incremental reader retries partial UTF-8 records and resets after truncation', t => {
 const root = fixture(t), file = path.join(root, 'main.jsonl'), a = JSON.stringify(log('user_message', 1, 'u', { content: 'Café 🎵' }));
 const bytes = Buffer.from(a + '\n'); fs.writeFileSync(file, bytes.subarray(0, bytes.length - 3));
 assert.equal(readEntriesIncremental(file, 0).newOffset, 0);
 fs.appendFileSync(file, bytes.subarray(bytes.length - 3));
 const full = readEntriesIncremental(file, 0); assert.equal(full.entries[0].attrs.content, 'Café 🎵'); assert.equal(full.newOffset, bytes.length);
 fs.writeFileSync(file, '{}\n'); assert.equal(readEntriesIncremental(file, full.newOffset).newOffset, 3);
});

test('debug cache reuses old entries and parses appended records without losing partial tails', t => {
 const root = fixture(t), file = write(path.join(root, 'main.jsonl'), [log('user_message', 1, 'u', { content: 'test' }), log('llm_request', 2, 'a', { inputTokens: 100 })]);
 assert.equal(parseDebugLog(file).totalInputTokens, 100);
 const next = JSON.stringify(log('llm_request', 3, 'b', { inputTokens: 200 })); fs.appendFileSync(file, next.slice(0, 40));
 assert.equal(parseDebugLog(file).totalInputTokens, 100); fs.appendFileSync(file, next.slice(40) + '\n');
 assert.equal(parseDebugLog(file).totalInputTokens, 300); assert.equal(parseDebugLog(file).totalInputTokens, 300);
 write(file, [log('user_message', 4, 'u', { content: 'replacement' }), log('llm_request', 5, 'a', { inputTokens: 1 })]); assert.equal(parseDebugLog(file).totalInputTokens, 1);
});

test('child logs are counted once despite duplicate references and cycles', t => {
 const root = fixture(t), file = write(path.join(root, 'main.jsonl'), [log('user_message', 1, 'u', { content: 'test' }), log('llm_request', 2, 'l', { inputTokens: 10 }), log('tool_call', 3, 'tool', {}, { name: 'runSubagent' }), log('child_session_ref', 4, 'ref', { childLogFile: 'child.jsonl' }, { parentSpanId: 'tool' }), log('child_session_ref', 5, 'ref2', { childLogFile: 'child.jsonl' }, { parentSpanId: 'tool' })]);
 write(path.join(root, 'child.jsonl'), [log('user_message', 2, 'cu', { content: 'child' }), log('llm_request', 3, 'cl', { inputTokens: 20 }), log('child_session_ref', 4, 'back', { childLogFile: 'main.jsonl' })]);
 assert.equal(parseDebugLog(file).totalInputTokens, 30);
});

test('dependency signature and central cache refresh when only child usage changes', t => {
 const root = fixture(t), file = write(path.join(root, 'session/main.jsonl'), [log('user_message', now - 1000, 'u', { content: 'test' }), log('llm_request', now - 999, 'l', { inputTokens: 10 }), log('tool_call', now - 998, 'tool', {}, { name: 'runSubagent' }), log('child_session_ref', now - 997, 'ref', { childLogFile: 'child.jsonl' }, { parentSpanId: 'tool' })]);
 const child = write(path.join(root, 'session/child.jsonl'), [log('user_message', now - 995, 'cu', { content: 'child' }), log('llm_request', now - 994, 'cl', { inputTokens: 20 })]);
 const source = usageFile(file), options = { now, usageFiles: [source], cacheFilePath: path.join(root, 'cache.json') };
 const signature = usageFileSignature(source); assert.equal(computeSpendSummaryFromChatSessionDirs('full', [], options).today.inputTokens, 30);
 fs.appendFileSync(child, JSON.stringify(log('llm_request', now - 993, 'cl2', { inputTokens: 40 })) + '\n');
 assert.notEqual(usageFileSignature(source), signature); assert.equal(computeSpendSummaryFromChatSessionDirs('full', [], options).today.inputTokens, 70);
});

test('transcript rewrites, array truncation, and field deletion replace old usage instead of adding it', t => {
 const root = fixture(t), file = path.join(root, 'chatSessions/session.jsonl');
 const request = cost => ({ timestamp: now - 1000, result: { metadata: { nanoAiu: cost, usage: { inputTokens: 10, outputTokens: 2 } } } });
 write(file, [{ kind: 0, v: { requests: [request(100), request(200)] } }, { kind: 2, k: ['requests'], i: 1, v: [] }, { kind: 3, k: ['requests', 0, 'result', 'metadata', 'usage', 'inputTokens'] }]);
 const rows = readSpendRequestsFromChatSession(file); assert.equal(rows.length, 1); assert.equal(rows[0].nanoAiu, 100); assert.equal(rows[0].inputTokens, 0); assert.equal(rows[0].outputTokens, 2);
 fs.appendFileSync(file, JSON.stringify({ kind: 0, v: { requests: [request(0)] } }) + '\n');
 assert.equal(readSpendRequestsFromChatSession(file)[0].nanoAiu, 0);
});

test('empty-window transcripts parse directly and future usage is excluded from dated spend', t => {
 const root = fixture(t), dir = path.join(root, 'emptyWindowChatSessions');
 const file = write(path.join(dir, 'session.jsonl'), [{ kind: 0, v: { requests: [{ timestamp: now + 1, message: { text: 'test' }, result: { metadata: { nanoAiu: 100 } } }] } }]);
 assert.equal(parseCopilotSessionFile(file).sourceType, 'chatSession');
 assert.equal(computeSpendSummaryFromChatSessionDirs('full', [{ dir, workspaceKey: 'empty', workspaceLabel: 'Empty' }], { now }).month.nanoAiu, 0);
});

test('shutdown metrics supply a session total without inventing dates for individual turns', t => {
 const root = fixture(t), file = write(path.join(root, 'session/events.jsonl'), [
  { id: 'u', type: 'user.message', timestamp: new Date(now - 1000).toISOString(), data: { content: 'test' } },
  { id: 'shutdown', type: 'session.shutdown', timestamp: new Date(now).toISOString(), data: { totalNanoAiu: 123456789, modelMetrics: { model: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 } } } } },
 ]);
 const s = parseCopilotSessionFile(file).summary; assert.equal(s.totalNanoAiu, 123456789); assert.equal(s.totalInputTokens, 100); assert.equal(s.totalCachedTokens, 60);
 const period = computeSpendSummaryFromChatSessionDirs('full', [], { now, usageFiles: [usageFile(file, 'background')] }); assert.equal(period.month.nanoAiu, 0); assert.equal(period.undatedRequests, 2);
});

test('mixed-model cumulative buckets preserve measured per-model charges and cached tokens', t => {
 const root = fixture(t), file = write(path.join(root, 'session/main.jsonl'), [log('user_message', now - 1000, 'u', { content: 'test' }), log('llm_request', now - 999, 'a', { model: 'a', inputTokens: 100, cachedTokens: 70, copilotUsageNanoAiu: 1000 }), log('llm_request', now - 998, 'b', { model: 'b', inputTokens: 200, cachedTokens: 100, copilotUsageNanoAiu: 2000 })]);
 const s = computeSpendSummaryFromChatSessionDirs('full', [], { now, usageFiles: [usageFile(file)] });
 assert.equal(s.today.cachedTokens, 170); assert.deepEqual(s.today.models.map(m => [m.label, m.nanoAiu, m.inputTokens]), [['b', 2000, 200], ['a', 1000, 100]]);
});

test('credit-only sidecars do not hide measured debug token totals', t => {
 const root = fixture(t), cli = path.join(root, 'cli'), debugRoot = path.join(root, 'debug');
 const events = write(path.join(cli, 'session/events.jsonl'), [{ id: 'event', type: 'user.message', timestamp: new Date(now - 1000).toISOString(), data: { content: 'test' } }]);
 fs.writeFileSync(path.join(path.dirname(events), 'vscode.requests.metadata.json'), JSON.stringify([{ copilotRequestId: 'event', creditsUsed: 1.5 }]));
 const debug = write(path.join(debugRoot, 'session/main.jsonl'), [log('user_message', now - 1000, 'u', { content: 'test' }), log('llm_request', now - 999, 'a', { inputTokens: 100, copilotUsageNanoAiu: 1500000000 })]);
 const s = computeSpendSummaryFromChatSessionDirs('full', [], { now, cliRoots: [cli], usageFiles: [usageFile(events, 'background'), usageFile(debug)] });
 assert.equal(s.today.nanoAiu, 1500000000); assert.equal(s.today.inputTokens, 100); assert.equal(s.today.requestCount, 1);
 setBackgroundCliRoots([cli], [], [debugRoot]); assert.equal(parseCopilotSessionFile(events).sourceType, 'debugLog'); setBackgroundCliRoots([]);
});

test('WAL-only usage updates invalidate the central cache and readers stay read-only', t => {
 const root = fixture(t), file = database(path.join(root, 'session/session.db'), [['t', null, { ...persisted(), timestamp: now - 1000 }]]);
 const writer = new DatabaseSync(file); t.after(() => writer.close()); writer.exec('PRAGMA journal_mode=WAL');
 const options = { now, usageFiles: [usageFile(file, 'background')], cacheFilePath: path.join(root, 'cache.json') };
 assert.equal(computeSpendSummaryFromChatSessionDirs('full', [], options).today.nanoAiu, 1500000000);
 const before = fs.readFileSync(file), signature = usageFileSignature(options.usageFiles[0]);
 writer.prepare('UPDATE turn_usage SET usage=?').run(JSON.stringify({ ...persisted(200, 2000000000), timestamp: now - 1000 }));
 assert.deepEqual(fs.readFileSync(file), before); assert.notEqual(usageFileSignature(options.usageFiles[0]), signature);
 assert.equal(computeSpendSummaryFromChatSessionDirs('full', [], options).today.nanoAiu, 2000000000); assert.deepEqual(fs.readFileSync(file), before);
});

test('foreign copied agent turns are excluded from the owning database', t => {
 const root = fixture(t), file = database(path.join(root, 'session/session.db'), [['own', null, persisted()], ['foreign', null, persisted(300, 9000000000)]]);
 const db = new DatabaseSync(file); db.prepare('INSERT INTO session_metadata VALUES (?, ?)').run('agentHost.foreignTurnIds', JSON.stringify(['foreign'])); db.close();
 assert.equal(readBackgroundSession(file).usage.length, 1); assert.equal(parseCopilotSessionFile(file).summary.totalNanoAiu, 1500000000);
});

test('merged terminal continuations reconcile each transcript billing identity exactly once', t => {
 const root = fixture(t), ts = now - 1000;
 const file = write(path.join(root, 'session/main.jsonl'), [
  log('user_message', ts, 'u', { content: 'test' }), log('llm_request', ts + 1, 'a', { responseId: 'r1', inputTokens: 100, copilotUsageNanoAiu: 1000 }),
  log('user_message', ts + 10, 'c', { content: '[Terminal notification: completed]' }), log('llm_request', ts + 11, 'b', { responseId: 'r2', inputTokens: 200, copilotUsageNanoAiu: 2000 }),
 ]);
 const dir = path.join(root, 'chatSessions'); write(path.join(dir, 'session.jsonl'), [{ kind: 0, v: { requests: ['r1','r2'].map((id,i)=>({ timestamp: ts+i*10, result: { metadata: { responseId: id, nanoAiu: (i+1)*1000 } } })) } }]);
 assert.equal(parseDebugLog(file).userMessages.length, 1);
 const spend = computeSpendSummaryFromChatSessionDirs('full', [{ dir, workspaceKey:'w', workspaceLabel:'Workspace' }], { now, usageFiles:[usageFile(file)] });
 assert.equal(spend.today.nanoAiu, 3000);assert.equal(spend.today.inputTokens, 300);assert.equal(spend.today.requestCount, 2);
});

test('VS Code 1.146 maps visible/chat storage ids to SDK ids in both directions', t => {
 const root=fixture(t), agents=path.join(root,'agentSessionData'),cli=path.join(root,'session-state');
 const file=database(path.join(agents,'visible-session/session.db'),[['host-turn','sdk-user',persisted()]]);
 const db=new DatabaseSync(file);db.prepare('INSERT INTO session_metadata VALUES (?,?)').run('defaultChatProviderData',JSON.stringify({sdkSessionId:'sdk-session'}));db.close();
 const events=write(path.join(cli,'sdk-session/events.jsonl'),[{id:'sdk-user',type:'user.message',timestamp:new Date(now-1000).toISOString(),data:{content:'test'}}]);
 database(path.join(agents,'sdk-session/session.db'),[]);
 const {resolveBackgroundFiles}=require('../out/backgroundIdentity');
 assert.equal(resolveBackgroundFiles(events,[cli],[agents]).dbFile,file);
 assert.equal(resolveBackgroundFiles(path.join(agents,'sdk-session/session.db'),[cli],[agents]).dbFile,file);
 const data=readBackgroundSession(file,[cli],[agents]);assert.equal(data.sessionId,'sdk-session');assert.equal(data.ownerSessionId,'visible-session');assert.equal(data.usage[0].timestamp,now-1000);
 const {backgroundDependencies}=require('../out/background');assert(backgroundDependencies(file,[cli],[agents]).includes(events));assert(backgroundDependencies(events,[cli],[agents]).includes(file+'-wal'));
 const spend=computeSpendSummaryFromChatSessionDirs('full',[],{now,cliRoots:[cli],agentRoots:[agents],usageFiles:[usageFile(file,'background','visible-session'),usageFile(events,'background','sdk-session')],cacheFilePath:path.join(root,'cache.json')});
 assert.equal(spend.today.nanoAiu,1500000000);assert.equal(spend.today.requestCount,1);assert.equal(spend.undatedRequests,undefined);
 const warm=computeSpendSummaryFromChatSessionDirs('full',[],{now,cliRoots:[cli],agentRoots:[agents],usageFiles:[usageFile(file,'background','visible-session'),usageFile(events,'background','sdk-session')],cacheFilePath:path.join(root,'cache.json')});assert.equal(warm.today.nanoAiu,spend.today.nanoAiu);
});

test('durable SDK usage records deduplicate by accounting identity and include child calls once', t => {
 const root=fixture(t), ts=new Date(now-1000).toISOString();
 const usage=(id,cost,input,source='sdk')=>({accounting:{sourceSessionId:source,usageId:id},model:'model',inputTokens:input,outputTokens:2,cacheReadTokens:0,copilotUsage:{totalNanoAiu:cost}});
 const file=write(path.join(root,'session/events.jsonl'),[
  {id:'user',type:'user.message',timestamp:ts,data:{content:'test'}},
  {id:'live',type:'assistant.usage',timestamp:ts,data:usage('call-1',100,10)},
  {id:'durable',type:'session.usage_record',timestamp:ts,data:{usage:usage('call-1',100,10)}},
  {id:'replayed-with-new-envelope',type:'session.usage_record',timestamp:ts,data:{usage:usage('call-1',100,10)}},
  {id:'child',agentId:'child-agent',type:'session.usage_record',timestamp:ts,data:{usage:usage('call-2',200,20,'child-sdk')}},
  {id:'checkpoint',type:'session.usage_checkpoint',timestamp:ts,data:{totalNanoAiu:100}},
 ]);
 const data=readBackgroundSession(file);assert.equal(data.usageRecordCount,2);assert.equal(data.usage.reduce((n,u)=>n+u.nanoAiu,0),300);assert.equal(data.usage.reduce((n,u)=>n+u.inputTokens,0),30);assert.equal(data.ledgerTotals.nanoAiu,300);assert.equal(parseCopilotSessionFile(file).summary.totalNanoAiu,300);
});

test('a delayed child call stays with its original parent after another user message arrives', t => {
 const root=fixture(t);let n=0;const event=(type,id,data={},agentId)=>({id,type,agentId,timestamp:new Date(now-1000+(n++)).toISOString(),data});
 const file=write(path.join(root,'session/events.jsonl'),[
  event('user.message','u1',{content:'first'}),event('tool.execution_start','tool-start',{toolCallId:'tool',toolName:'task'}),event('subagent.started','child-start',{toolCallId:'tool'},'child'),
  event('user.message','u2',{content:'second'}),event('session.usage_record','usage',{usage:{model:'model',inputTokens:10,outputTokens:1,copilotUsage:{totalNanoAiu:100}}},'child'),
 ]);
 const data=readBackgroundSession(file);assert.equal(data.usage[0].owner,'u1');assert.equal(data.usage[0].nanoAiu,100);
});

test('compaction accounting and live duplicate usage reconcile by shared call id', t => {
 const root=fixture(t),u={apiCallId:'compact-call',model:'model',inputTokens:10,outputTokens:2,copilotUsage:{totalNanoAiu:300}};
 const file=write(path.join(root,'session/events.jsonl'),[
  {id:'u',type:'user.message',timestamp:new Date(now-1000).toISOString(),data:{content:'test'}},
  {id:'live',type:'assistant.usage',timestamp:new Date(now-500).toISOString(),data:{...u,interactionType:'conversation-compaction'}},
  {id:'complete',type:'session.compaction_complete',timestamp:new Date(now-499).toISOString(),data:{success:true,compactionTokensUsed:u}},
 ]);
 const data=readBackgroundSession(file);assert.equal(data.usageRecordCount,1);assert.equal(data.usage[0].nanoAiu,300);assert.equal(data.usage[0].inputTokens,10);
});

test('new usage event types produce an explicit coverage diagnostic', t => {
 const root=fixture(t),file=write(path.join(root,'session/events.jsonl'),[{id:'new',type:'session.future_usage',timestamp:new Date(now).toISOString(),data:{}}]);
 const data=readBackgroundSession(file);assert.deepEqual(data.unknownUsageEvents,['session.future_usage']);assert(data.notes.some(n=>n.includes('coverage needs review')));
});

test('coverage audit reconciles usage multisets across different event ids and reports orphan index calls', t => {
 const root=fixture(t),cli=path.join(root,'session-state');fs.mkdirSync(cli);
 const ts=new Date(now-1000).toISOString();write(path.join(cli,'sdk/events.jsonl'),[{id:'durable-id',type:'session.usage_record',timestamp:ts,data:{usage:{model:'model',inputTokens:10,outputTokens:2,cacheReadTokens:5,copilotUsage:{totalNanoAiu:100}}}}]);
 const db=new DatabaseSync(path.join(root,'session-store.db'));db.exec('CREATE TABLE assistant_usage_events(session_id TEXT,agent_id TEXT,model TEXT,created_at TEXT,total_nano_aiu INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER)');
 db.prepare('INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?)').run('sdk',null,'model',new Date(now-999).toISOString(),100,10,2,5);
 db.prepare('INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?)').run('missing-sdk',null,'model',ts,200,20,4,10);db.close();
 const {auditCoverage}=require('../scripts/audit-coverage.cjs');const report=auditCoverage({directories:{debug:[],chat:[],cli:[cli],agent:[]}});
 assert.equal(report.sdkCalls,1);assert.equal(report.indexedCalls,2);assert.equal(report.indexedCallsWithoutMatchingLog,1);assert.equal(report.logCallsWithoutMatchingIndex,0);assert.deepEqual(report.indexedSessionsWithoutEventFile,['missing-sdk']);
});
