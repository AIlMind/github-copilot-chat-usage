const fs = require('node:fs');
const path = require('node:path');
const { withDatabaseSnapshot } = require('../out/sqliteSnapshot');
const { discoverUsageDirectories } = require('../out/discovery');
const { readBackgroundSession, readJsonLines } = require('../out/background');
const { prepareBackgroundIndex, resolveBackgroundFiles } = require('../out/backgroundIdentity');

function filesUnder(root, filename) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name, filename)).filter(fs.existsSync); }
  catch { return []; }
}
function count(value) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function callKey(call) {
  // The live assistant.usage id and durable usage_record id are different. Compare
  // measured-call multisets rather than claiming those event identities are equal.
  return JSON.stringify([call.session, call.agent || '', call.model, call.nanoAiu ?? null, call.input ?? null, call.output ?? null, call.cached ?? null]);
}
function add(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function totals(calls) {
  return calls.reduce((sum, call) => ({ nanoAiu: sum.nanoAiu + count(call.nanoAiu), inputTokens: sum.inputTokens + count(call.input), outputTokens: sum.outputTokens + count(call.output), cachedTokens: sum.cachedTokens + count(call.cached) }), { nanoAiu: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
}
function auditCoverage(options = {}) {
  const dirs = options.directories || discoverUsageDirectories(options);
  prepareBackgroundIndex(dirs.agent);
  const sdkFiles = dirs.cli.flatMap(root => filesUnder(root, 'events.jsonl'));
  const agentFiles = dirs.agent.flatMap(root => filesUnder(root, 'session.db'));
  const sdkCalls = [], indexedCalls = [], indexErrors = [];
  const sdkIds = new Set(), seenUsage = new Set(), eventTypes = new Set();
  for (const file of sdkFiles) {
    const session = path.basename(path.dirname(file)); sdkIds.add(session);
    readJsonLines(file, event => {
      if (typeof event.type === 'string' && event.type.includes('usage')) eventTypes.add(event.type);
      if (event.type !== 'session.usage_record') return;
      const u = event.data?.usage;
      if (!u) return;
      const key = `${u.accounting?.sourceSessionId || session}:${u.accounting?.usageId || u.apiCallId || event.id}`;
      if (seenUsage.has(key)) return;
      seenUsage.add(key);
      sdkCalls.push({ session, agent: event.agentId, model: u.model, time: event.timestamp, nanoAiu: u.copilotUsage?.totalNanoAiu, input: u.inputTokens, output: u.outputTokens, cached: u.cacheReadTokens });
    });
  }
  for (const root of dirs.cli) {
    const indexFile = path.join(path.dirname(root), 'session-store.db');
    if (!fs.existsSync(indexFile)) continue;
    try {
      withDatabaseSnapshot(indexFile, db => {
      const rows = db.prepare('SELECT session_id, agent_id, model, created_at, total_nano_aiu, input_tokens, output_tokens, cache_read_tokens FROM assistant_usage_events').all();
      for (const r of rows) indexedCalls.push({ session: r.session_id, agent: r.agent_id, model: r.model, time: r.created_at, nanoAiu: r.total_nano_aiu, input: r.input_tokens, output: r.output_tokens, cached: r.cache_read_tokens });
      });
    } catch (error) { indexErrors.push({ file: indexFile, error: String(error.message) }); }
  }
  const logCounts = new Map(), indexCounts = new Map();
  sdkCalls.forEach(c => add(logCounts, callKey(c))); indexedCalls.forEach(c => add(indexCounts, callKey(c)));
  let indexedCallsWithoutMatchingLog = 0, logCallsWithoutMatchingIndex = 0;
  for (const [key, n] of indexCounts) indexedCallsWithoutMatchingLog += Math.max(0, n - (logCounts.get(key) || 0));
  for (const [key, n] of logCounts) logCallsWithoutMatchingIndex += Math.max(0, n - (indexCounts.get(key) || 0));
  const sessions = new Map();
  let remappedAgentStores = 0, agentStoresWithoutUsage = 0, unreadableAgentStores = 0;
  for (const file of agentFiles) {
    const identity = resolveBackgroundFiles(file, dirs.cli, dirs.agent);
    const data = readBackgroundSession(file, dirs.cli, dirs.agent);
    if (identity.ownerSessionId !== identity.sessionId) remappedAgentStores++;
    if (!data.usage.length) agentStoresWithoutUsage++;
    if (data.notes.some(n => n.includes('unavailable or unreadable'))) unreadableAgentStores++;
    if (data.usage.length) sessions.set(data.sessionId, data);
  }
  const reconciliation = [];
  for (const [session, data] of sessions) {
    const logs = sdkCalls.filter(c => c.session === session);
    const index = indexedCalls.filter(c => c.session === session);
    const saved = data.usage.reduce((sum, u) => ({ nanoAiu: sum.nanoAiu + u.nanoAiu, inputTokens: sum.inputTokens + u.inputTokens, outputTokens: sum.outputTokens + u.outputTokens, cachedTokens: sum.cachedTokens + u.cachedTokens }), { nanoAiu: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    reconciliation.push({ session, saved, sdkLog: totals(logs), sdkIndex: totals(index), calls: logs.length, subagentCalls: logs.filter(c => c.agent).length, datedTurns: data.usage.filter(u => u.timestamp !== undefined).length, undatedTurns: data.usage.filter(u => u.timestamp === undefined).length, agrees: logs.length > 0 && JSON.stringify(saved) === JSON.stringify(totals(logs)) && JSON.stringify(saved) === JSON.stringify(totals(index)), notes: data.notes });
  }
  return {
    generatedAt: new Date().toISOString(), roots: Object.fromEntries(Object.entries(dirs).map(([key, values]) => [key, values.length])),
    sdkSessions: sdkFiles.length, agentStores: agentFiles.length, remappedAgentStores, agentStoresWithoutUsage, unreadableAgentStores,
    sdkCalls: sdkCalls.length, indexedCalls: indexedCalls.length, indexedCallsWithoutMatchingLog, logCallsWithoutMatchingIndex,
    indexedSessionsWithoutEventFile: [...new Set(indexedCalls.filter(c => !sdkIds.has(c.session)).map(c => c.session))], indexErrors,
    usageEventTypes: [...eventTypes].sort(), reconciliation,
    comparison: 'Per-session, per-agent, per-model measured-usage multisets. Cross-store event identities are not equated.',
    scope: 'Local Copilot stores visible to this process. Does not certify inaccessible remote/cloud hosts, unsaved calls, or Claude/Codex provider-specific history.',
  };
}
module.exports = { auditCoverage };
if (require.main === module) {
  const argv = process.argv.slice(2), searchRoots = [];
  let globalStoragePath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--search-root') searchRoots.push(argv[++i]);
    if (argv[i] === '--user-data-dir') globalStoragePath = path.join(argv[++i], 'User', 'globalStorage', 'ailmind.github-copilot-chat-usage');
  }
  const report = auditCoverage({ searchRoots, globalStoragePath });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
