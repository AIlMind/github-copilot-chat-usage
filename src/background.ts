import * as fs from 'fs';
import * as path from 'path';
import { canonicalModelId } from './modelNames';
import { StringDecoder } from 'string_decoder';
import { readUsageEvents } from './eventLog';
import { AgentDetails, RoutingDecision, PermissionCheck, CatalogPrice, ModelSelection, catalogPrices } from './backgroundDiagnostics';
import type { LogEntry } from './parser';
import { contentSignature, withDatabaseSnapshot } from './sqliteSnapshot';
import { resolveBackgroundFiles } from './backgroundIdentity';

export interface BackgroundUsage {
    modelUsage?: { model: string; nanoAiu: number; inputTokens: number; outputTokens: number; cachedTokens: number; estimated?: boolean }[];
    tokensKnown?: boolean;
    intervalStart?: number;
    intervalEnd?: number;
    kind?: 'call' | 'saved' | 'adjustment';
    owner?: string;
    callKey?: string;
    detail?: any;
    id: string;
    timestamp?: number;
    nanoAiu: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    model: string;
    eventId?: string;
}

export interface BackgroundData {
    modelSelections: ModelSelection[];
    routing: RoutingDecision[];
    agents: AgentDetails[];
    permissionChecks: PermissionCheck[];
    catalog: CatalogPrice[];
    sessionId: string;
    ownerSessionId: string;
    entries: LogEntry[];
    usage: BackgroundUsage[];
    title?: string;
    notes: string[];
    sessionNanoAiu?: number;
    usageRecordCount: number;
    ledgerTotals: { nanoAiu: number; inputTokens: number; outputTokens: number; cachedTokens: number };
    unknownUsageEvents: string[];
    hookDurationMs: number;
    compactionCount: number;
    codeChanges?: { linesAdded?: number; linesRemoved?: number; filesChanged?: number };
}

export function hasRecordedTokenTotals(data: BackgroundData): boolean {
    // Credit-only reconciliation rows must not demote an otherwise detailed call ledger.
    return data.usage.some(u => u.tokensKnown === true);
}

export function readJsonLines(file: string, onValue: (value: any) => void): void {
    const fd = fs.openSync(file, 'r');
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(64 * 1024);
    let pending = '';
    try {
        let count: number;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            pending += decoder.write(buffer.subarray(0, count));
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                try { onValue(JSON.parse(line)); } catch { /* Skip torn or malformed records. */ }
            }
        }
        pending += decoder.end();
        if (pending.trim()) { try { onValue(JSON.parse(pending)); } catch { /* Partial tail; retry next scan. */ } }
    } finally { fs.closeSync(fd); }
}

function number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function json(file: string): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** Read only usage and identity columns. Never run migrations or write to VS Code's database. */
function readDatabase(file: string, notes: Set<string>): any[] {
    try {
        return withDatabaseSnapshot(file, db => {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
            if (!tables.includes('turn_usage')) { return []; }
            const foreign = new Set<string>();
            if (tables.includes('session_metadata')) {
                const row = db.prepare("SELECT value FROM session_metadata WHERE key = 'agentHost.foreignTurnIds'").get();
                if (row) { for (const id of JSON.parse(row.value)) { foreign.add(id); } }
            }
            const columns = tables.includes('turns') ? db.prepare('PRAGMA table_info(turns)').all().map((c: any) => c.name) : [];
            const query = columns.includes('event_id')
                ? 'SELECT u.turn_id AS id, t.event_id AS eventId, u.usage FROM turn_usage u LEFT JOIN turns t ON t.id = u.turn_id ORDER BY u.rowid'
                : 'SELECT turn_id AS id, usage FROM turn_usage ORDER BY rowid';
            return db.prepare(query).all().filter((r: any) => !foreign.has(r.id)).flatMap((r: any) => {
                try { return [{ ...r, usage: JSON.parse(r.usage) }]; } catch { notes.add('Some saved usage records are unreadable.'); return []; }
            });
        });
    } catch (error) {
        notes.add('Saved agent usage is unavailable or unreadable.');
        return [];
    }
}

export function backgroundDependencies(file: string, cliRoots: string[], agentRoots: string[] = []): string[] {
    const resolved = resolveBackgroundFiles(file, cliRoots, agentRoots);
    return [file, ...resolved.dirs.flatMap(dir => ['events.jsonl', 'vscode.requests.metadata.json', 'vscode.metadata.json', 'session.db', 'session.db-wal', 'session.db-journal'].map(name => path.join(dir, name)))];
}

const usagePresenceCache = new Map<string, { signature: string; present: boolean }>();
/** Stop at the first usage event. Empty stores are checked again when their content changes. */
export function backgroundHasUsage(file: string, cliRoots: string[], agentRoots: string[]): boolean {
    const files = resolveBackgroundFiles(file, cliRoots, agentRoots);
    if (files.hasSavedUsage) { return true; }
    if (files.eventsFile) {
        const eventFile = files.eventsFile;
        const signature = contentSignature(eventFile);
        const cached = usagePresenceCache.get(eventFile);
        if (cached?.signature === signature && cached.present) { return true; }
        let present = false;
        let pending = '';
        const fd = cached?.signature === signature ? undefined : fs.openSync(eventFile, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        try {
            let count: number;
            while (fd !== undefined && !present && (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
                pending += buffer.subarray(0, count).toString('utf8');
                let end: number;
                while (!present && (end = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, end); pending = pending.slice(end + 1);
                    if (!/"(?:assistant\.usage|session\.usage_record|session\.usage_checkpoint|session\.shutdown|session\.compaction_complete)"/.test(line)) { continue; }
                    try { const e = JSON.parse(line); present = ['assistant.usage', 'session.usage_record'].includes(e.type) || typeof e.data?.totalNanoAiu === 'number' || !!e.data?.compactionTokensUsed; } catch {}
                }
            }
        } finally { if (fd !== undefined) { fs.closeSync(fd); } }
        usagePresenceCache.set(eventFile, { signature, present });
        if (present) { return true; }
    }
    return files.dirs.some(dir => json(path.join(dir, 'vscode.requests.metadata.json'))?.some?.((r: any) => typeof r.creditsUsed === 'number'));
}

/** Keep durable calls, saved turn remainders, and cumulative adjustments distinct. */
export function readBackgroundSession(file: string, cliRoots: string[] = [], agentRoots: string[] = []): BackgroundData {
    const resolved = resolveBackgroundFiles(file, cliRoots, agentRoots);
    const { sessionId, dirs, eventsFile, dbFile } = resolved;
    const notes = new Set<string>();
    const entries: LogEntry[] = [];
    const users = new Map<string, { ts: number; content: string }>();
    const seen = new Set<string>();
    const toolStarts = new Map<string, LogEntry>();
    const agentOwners = new Map<string, string>();
    const agents = new Map<string, AgentDetails>();
    const agentByTool = new Map<string, string>();
    const routing: RoutingDecision[] = [];
    const modelSelections: ModelSelection[] = [];
    const agentModels = new Map<string, { model?: string; reasoningEffort?: string; contextTier?: string }>();
    const permissionChecks: PermissionCheck[] = [];
    const catalog: CatalogPrice[] = [];
    const modelTrace = new Map<string, { id: string; owner?: string; ts: number; model: string; prices: CatalogPrice[]; retry?: boolean; pendingRetry?: boolean }>();
    const traceForEvent = new Map<string, string>();
    const turns = new Map<string, { ts: number; owner?: string }>();
    const ownerById = new Map<string, string>();
    const eventTurns = new Map<string, string>();
    const activeTurns = new Map<string, string>();
    const apiTurns = new Map<string, string>();
    const toolTurns = new Map<string, string>();
    const callAliases = new Map<string, string>();
    const calls = new Map<string, { owner?: string; timestamp: number; usage: any; priority: number; callKey?: string; agentId?: string }>();
    const snapshots: { ts?: number; start?: number; total: number; data: any }[] = [];
    const hooks = new Map<string, number>();
    let hookDurationMs = 0;
    let compactionCount = 0;
    let currentUser: string | undefined;
    let selectedModel = resolved.selectedModel ?? 'Unknown model';
    let selectedEffort: string | undefined, selectedContext: string | undefined;
    let autoTier = resolved.autoTier;
    let title: string | undefined;
    let sessionStart: number | undefined;
    let terminalTime = 0;
    const unknownUsageEvents = new Set<string>();
    if (eventsFile) {
        readUsageEvents(eventsFile, event => {
            if (!event || (event.id && seen.has(event.id))) { return; }
            if (event.id) { seen.add(event.id); }
            const data = event.data ?? {};
            const ts = timestamp(event.timestamp);
            if (!ts) { return; }
            if (['session.start', 'session.resume'].includes(event.type)) {
                if (event.type === 'session.start') { sessionStart ??= ts; }
                selectedModel = data.selectedModel ?? selectedModel; selectedEffort = data.reasoningEffort ?? selectedEffort;
                selectedContext = data.contextTier ?? selectedContext; autoTier = data.autoTier ?? autoTier;
                modelSelections.push({ timestamp: ts, model: selectedModel, source: event.type, reasoningEffort: selectedEffort, contextTier: selectedContext, autoTier });
            }
            if (event.type === 'session.model_change' && typeof data.newModel === 'string') {
                if (event.agentId) { agentModels.set(event.agentId, { model: data.newModel, reasoningEffort: data.reasoningEffort, contextTier: data.contextTier }); }
                else if (data.source !== 'agent') { selectedModel = data.newModel; selectedEffort = data.reasoningEffort; selectedContext = data.contextTier; }
                modelSelections.push({ timestamp: ts, model: data.newModel, agentId: event.agentId, owner: event.agentId ? agentOwners.get(event.agentId) : currentUser, source: data.source ?? 'session.model_change', reasoningEffort: data.reasoningEffort, contextTier: data.contextTier, autoTier });
            }
            if (event.type === 'session.title_changed') { title = data.title; }
            if (['session.shutdown', 'session.abort', 'abort'].includes(event.type)) { terminalTime = ts; }
            if (['session.shutdown', 'session.usage_checkpoint'].includes(event.type) && typeof (data.totalNanoAiu ?? data.accountingSnapshot?.totalNanoAiu) === 'number') {
                snapshots.push({ ts, start: sessionStart, total: number(data.totalNanoAiu ?? data.accountingSnapshot.totalNanoAiu), data: { ...data, ...data.accountingSnapshot } });
            }
            if (event.type === 'user.message' && !event.agentId && !data.parentToolCallId) {
                currentUser = event.id;
                users.set(currentUser!, { ts, content: typeof data.content === 'string' ? data.content : '' });
            }
            if (event.type === 'subagent.started' && event.agentId) {
                const owner = toolStarts.get(data.toolCallId)?.attrs.userMessageId ?? currentUser;
                if (owner) { agentOwners.set(event.agentId, owner); }
                agentByTool.set(data.toolCallId, event.agentId);
                agents.set(event.agentId, { id: event.agentId, owner, name: data.agentDisplayName ?? data.agentName ?? event.agentId,
                    type: data.agentType, model: data.model, reasoningEffort: data.reasoningEffort, contextTier: data.contextTier, modelSelectionSource: data.modelSelectionSource, startedAt: ts });
            }
            if (['subagent.started', 'subagent.configured', 'subagent.selected'].includes(event.type)) {
                const id = event.agentId ?? agentByTool.get(data.toolCallId);
                if (id) {
                    const previous = agentModels.get(id) ?? {};
                    const selection = { model: data.model ?? previous.model, reasoningEffort: data.reasoningEffort ?? previous.reasoningEffort, contextTier: data.contextTier ?? previous.contextTier };
                    agentModels.set(id, selection);
                    const agent = agents.get(id); if (agent) { Object.assign(agent, selection); }
                }
            }
            if (event.type === 'subagent.completed') {
                const id = event.agentId ?? agentByTool.get(data.toolCallId);
                const agent = id && agents.get(id);
                if (agent) { Object.assign(agent, { completed: true, durationMs: optionalNumber(data.durationMs), toolCalls: optionalNumber(data.totalToolCalls), tokens: optionalNumber(data.totalTokens), model: data.model ?? data.firstDispatchedModel ?? agent.model, modelSelectionSource: data.modelSelectionSource ?? agent.modelSelectionSource }); }
            }
            // A queued message can follow its turn_start. The ancestry of the billed
            // event wins over that early turn's owner; interleaved agents retain their root prompt.
            const owner = event.agentId ? agentOwners.get(event.agentId) :
                event.type === 'user.message' && !data.parentToolCallId ? event.id :
                event.parentId ? ownerById.get(event.parentId) : currentUser;
            if (event.id && owner) { ownerById.set(event.id, owner); }
            if (event.type === 'session.auto_mode_resolved') {
                routing.push({ timestamp: ts, owner, agentId: event.agentId, chosenModel: data.chosenModel, tier: data.autoTier ?? autoTier, method: data.routingMethod, availableModels: data.availableModels?.filter?.((m: any) => typeof m === 'string'), fallback: data.fallback, reason: data.selectionReason,
                    scores: data.categoryScores && typeof data.categoryScores === 'object' ? Object.fromEntries(Object.entries(data.categoryScores).filter(([,v]) => optionalNumber(v) !== undefined)) as Record<string,number> : undefined,
                    candidates: Array.isArray(data.candidateModels) ? data.candidateModels.filter((m: any) => typeof m === 'string') : [], latencyMs: optionalNumber(data.endToEndLatencyMs) });
            }
            if (typeof event.type === 'string' && event.type.startsWith('model.')) {
                let trace = traceForEvent.get(event.parentId);
                if (event.type === 'model.turn_retry' && trace && modelTrace.has(trace)) { modelTrace.get(trace)!.pendingRetry = true; }
                if (event.type === 'model.model_call_started') {
                    const previous = trace && modelTrace.get(trace);
                    trace = event.id;
                    const prices = catalogPrices(data.model, ts, data.modelInfo?.billing);
                    catalog.push(...prices);
                    modelTrace.set(trace!, { id: event.id, owner, ts, model: data.model ?? 'Unknown model', prices, retry: !!previous?.pendingRetry });
                }
                if (trace) { traceForEvent.set(event.id, trace); }
                if (['model.model_call_failure', 'model.model_call_completed', 'model.model_call_success'].includes(event.type)) {
                    let judge = data.purpose === 'permission' || data.modelCall?.purpose === 'permission';
                    // Older SDK traces identify the permission judge only by its system instruction.
                    // Inspect that signature locally and retain no request messages or prompt text.
                    if (!judge && data.requestMessages) {
                        try { const messages = typeof data.requestMessages === 'string' ? JSON.parse(data.requestMessages) : data.requestMessages;
                            judge = Array.isArray(messages) && messages.some((m: any) => m.role === 'system' && typeof m.content === 'string' && /^(You judge one proposed developer-tool action\.|You are the permission judge\b)/.test(m.content));
                        } catch {}
                    }
                    if (judge) {
                        const start = trace && modelTrace.get(trace);
                        const prices = start?.prices[0];
                        const recorded = data.modelCall?.usage ?? data.usage ?? data.responseChunk?.usage;
                        permissionChecks.push({ inputTokens: optionalNumber(recorded?.prompt_tokens), outputTokens: optionalNumber(recorded?.completion_tokens), cachedTokens: optionalNumber(recorded?.prompt_tokens_details?.cached_tokens), cacheWriteTokens: optionalNumber(recorded?.prompt_tokens_details?.cache_write_tokens), id: trace ?? event.id, owner: start?.owner ?? owner, timestamp: start?.ts ?? ts,
                            model: data.modelCall?.model ?? start?.model ?? 'Unknown model', durationMs: optionalNumber(data.modelCallDurationMs),
                            failed: event.type === 'model.model_call_failure', retry: number(data.modelCall?.retry_attempt) > 0 || !!start?.retry || !!start?.pendingRetry,
                            listedFree: prices && ['input','output','cache_read','cache_write'].every(t => prices.rates[t] === 0) ? true : undefined });
                    }
                }
            }
            const turnKey = data.turnId !== undefined ? `${event.agentId ?? 'main'}:${data.turnId}` : undefined;
            if (event.type === 'assistant.turn_start' && turnKey) {
                turns.set(event.id, { ts, owner });
                activeTurns.set(turnKey, event.id);
                eventTurns.set(event.id, event.id);
            }
            if (event.type === 'assistant.message') {
                const key = (turnKey && activeTurns.get(turnKey)) ?? eventTurns.get(event.parentId);
                if (key) {
                    eventTurns.set(event.id, key);
                    if (data.apiCallId) { apiTurns.set(data.apiCallId, key); }
                    for (const tool of data.toolRequests ?? []) { if (tool.toolCallId) { toolTurns.set(tool.toolCallId, data.apiCallId ? `api:${data.apiCallId}` : key); } }
                }
            }
            if (typeof event.type === 'string' && event.type.includes('usage') &&
                !['assistant.usage', 'session.usage_record', 'session.usage_checkpoint', 'session.usage_info'].includes(event.type)) {
                unknownUsageEvents.add(event.type);
            }
            if (['assistant.usage', 'session.usage_record', 'session.compaction_complete'].includes(event.type)) {
                const usage = event.type === 'session.usage_record' ? data.usage :
                    event.type === 'session.compaction_complete' ? data.compactionTokensUsed : data;
                if (usage && typeof usage === 'object') {
                    const source = usage.accounting?.sourceSessionId ?? sessionId;
                    const aliases = [usage.accounting?.usageId, usage.apiCallId, usage.serviceRequestId].filter(Boolean).map(id => `${source}:${id}`);
                    const key = aliases.map(id => callAliases.get(id)).find(Boolean) ?? aliases[0] ?? `${source}:${event.id}`;
                    for (const alias of aliases) { callAliases.set(alias, key); }
                    const priority = event.type === 'session.compaction_complete' ? 3 : event.type === 'session.usage_record' ? 2 : 1;
                    const callKey = (usage.apiCallId && apiTurns.get(usage.apiCallId)) || eventTurns.get(event.parentId) || (turnKey && activeTurns.get(turnKey));
                    if (!calls.has(key) || calls.get(key)!.priority < priority) {
                        calls.set(key, { owner: owner || (callKey && turns.get(callKey)?.owner), timestamp: ts, usage: { ...usage, model: usage.model ?? (event.agentId ? agentModels.get(event.agentId)?.model : selectedModel), reasoningEffort: usage.reasoningEffort ?? (event.agentId ? agentModels.get(event.agentId)?.reasoningEffort : selectedEffort), contextTier: usage.contextTier ?? (event.agentId ? agentModels.get(event.agentId)?.contextTier : selectedContext) }, priority, callKey, agentId: event.agentId });
                    }
                }
            }
            if (event.type === 'tool.execution_start') {
                const callKey = toolTurns.get(data.toolCallId) ?? (turnKey && activeTurns.get(turnKey)) ?? eventTurns.get(event.parentId);
                const tool: LogEntry = { ts, dur: 0, sid: sessionId, type: 'tool_call', name: data.toolName ?? 'tool', spanId: data.toolCallId ?? event.id, status: 'pending', attrs: { toolCallId: data.toolCallId, args: JSON.stringify(data.arguments), displayLabel: typeof data.toolTitle === 'string' ? data.toolTitle : undefined, userMessageId: owner, modelCallId: callKey } };
                toolStarts.set(tool.spanId, tool);
                entries.push(tool);
            }
            if (event.type === 'tool.execution_complete') {
                const tool = toolStarts.get(data.toolCallId);
                if (tool) { tool.dur = Math.max(0, ts - tool.ts); tool.status = data.success === false ? 'error' : 'ok'; }
            }
            if (event.type === 'session.compaction_complete' && data.success !== false) { compactionCount++; }
            if (event.type === 'hook.start') { hooks.set(data.hookInvocationId, ts); }
            if (event.type === 'hook.end') {
                const start = hooks.get(data.hookInvocationId);
                if (start !== undefined) { hookDurationMs += Math.max(0, ts - start); hooks.delete(data.hookInvocationId); }
            }
        });
    }
    for (const route of routing) {
        if (!route.owner && !route.agentId) { route.owner = [...users].find(([,u]) => u.ts >= route.timestamp)?.[0]; }
    }
    if (!modelSelections.length && resolved.selectedModel) { modelSelections.push({ timestamp: 0, model: resolved.selectedModel, source: 'saved selection', autoTier: resolved.autoTier }); }
    for (const tool of toolStarts.values()) {
        if (tool.status === 'pending' && terminalTime >= tool.ts) { tool.status = 'interrupted'; }
    }
    const usage: BackgroundUsage[] = [];
    const ledgerTotals = { nanoAiu: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    for (const [key, call] of calls) {
        const data = call.usage;
        const callKey = (data.apiCallId && apiTurns.get(data.apiCallId)) || call.callKey;
        const owner = call.owner || (callKey && turns.get(callKey)?.owner) || `unattributed:${key}`;
        const u: BackgroundUsage = {
            id: key, eventId: key, owner, kind: 'call', callKey: data.apiCallId ? `api:${data.apiCallId}` : callKey,
            timestamp: call.timestamp, intervalEnd: call.timestamp,
            nanoAiu: number(data.copilotUsage?.totalNanoAiu), inputTokens: number(data.inputTokens), outputTokens: number(data.outputTokens), cachedTokens: number(data.cacheReadTokens),
            model: data.model ?? selectedModel, tokensKnown: typeof data.inputTokens === 'number' && typeof data.outputTokens === 'number',
            detail: { ...data, agentId: call.agentId, startedAt: callKey ? turns.get(callKey)?.ts : undefined },
        };
        for (const field of ['nanoAiu', 'inputTokens', 'outputTokens', 'cachedTokens'] as const) { ledgerTotals[field] += u[field]; }
        if (data.copilotUsage?.totalNanoAiu === undefined && data.isByok !== true) { notes.add('Some model calls have no measured credits; session cost is incomplete.'); }
        usage.push(u);
    }
    for (const type of unknownUsageEvents) { notes.add(`Unrecognized usage event: ${type}; coverage needs review.`); }
    const rows = dbFile && resolved.hasSavedUsage !== false ? readDatabase(dbFile, notes) : [];
    let savedSessionTotal: number | undefined;
    for (const row of rows) {
        const u = row.usage;
        const meta = u?._meta ?? {};
        const id = row.eventId ?? row.id;
        const known = usage.filter(c => c.owner === id);
        const persistedRoute = meta.autoModeResolved;
        if (persistedRoute && !routing.some(r => r.owner === id && !r.agentId)) {
            routing.push({ timestamp: users.get(id)?.ts ?? timestamp(u.timestamp) ?? 0, owner: id, chosenModel: persistedRoute.chosenModel,
                tier: persistedRoute.autoTier ?? autoTier, reason: persistedRoute.selectionReason, scores: persistedRoute.categoryScores,
                candidates: Array.isArray(persistedRoute.candidateModels) ? persistedRoute.candidateModels : [], method: persistedRoute.routingMethod, latencyMs: optionalNumber(persistedRoute.endToEndLatencyMs) });
        }
        const totals = Array.isArray(meta.turnTokenTotals) ? meta.turnTokenTotals : undefined;
        const modelNames = [...new Set<string>(totals?.map((t: any) => t.model).filter(Boolean) ?? [u.model ?? selectedModel])];
        const remainder: BackgroundUsage = {
            id: row.id, eventId: row.eventId, owner: id, kind: 'saved', tokensKnown: !!totals,
            timestamp: users.get(id)?.ts ?? timestamp(u.timestamp),
            intervalEnd: Math.max(0, ...known.map(c => c.timestamp ?? 0)) || users.get(id)?.ts || timestamp(u.timestamp),
            nanoAiu: number(meta.copilotUsage?.totalNanoAiu),
            inputTokens: totals?.reduce((s: number, t: any) => s + number(t.inputTokens), 0) ?? 0,
            outputTokens: totals?.reduce((s: number, t: any) => s + number(t.outputTokens), 0) ?? 0,
            cachedTokens: totals?.reduce((s: number, t: any) => s + number(t.cachedTokens), 0) ?? 0,
            model: modelNames.length === 1 ? modelNames[0] : 'Mixed models',
        };
        if (remainder.timestamp !== undefined && remainder.intervalEnd !== undefined && remainder.intervalEnd > remainder.timestamp) {
            remainder.intervalStart = remainder.timestamp;
            remainder.timestamp = remainder.intervalEnd;
        }
        // Saved totals include descendant calls. Preserve their detail and add only missing usage.
        for (const field of ['nanoAiu', 'inputTokens', 'outputTokens', 'cachedTokens'] as const) {
            remainder[field] = Math.max(0, remainder[field] - known.reduce((sum, c) => sum + c[field], 0));
        }
        if (totals?.length) {
            const grouped = new Map<string, {model:string; inputTokens:number; outputTokens:number; cachedTokens:number; nanoAiu:number; estimated:boolean}>();
            for (const t of totals) {
                const key = canonicalModelId(t.model ?? 'Unknown model');
                const m = grouped.get(key) ?? {model:t.model ?? 'Unknown model',inputTokens:0,outputTokens:0,cachedTokens:0,nanoAiu:0,estimated:true};
                m.inputTokens += number(t.inputTokens); m.outputTokens += number(t.outputTokens); m.cachedTokens += number(t.cachedTokens); grouped.set(key,m);
            }
            for (const c of known) {
                const m = grouped.get(canonicalModelId(c.model));
                if (m) { for (const f of ['inputTokens','outputTokens','cachedTokens'] as const) { m[f] = Math.max(0,m[f]-c[f]); } }
            }
            const models = [...grouped.values()];
            for (const model of models) { model.estimated = models.length > 1; }
            for (const f of ['inputTokens','outputTokens','cachedTokens'] as const) {
                const sum = models.reduce((n,m)=>n+m[f],0);
                if (sum !== remainder[f]) {
                    let assigned = 0;
                    for (let i=0;i<models.length;i++) { const part = i === models.length-1 ? remainder[f]-assigned : Math.floor(remainder[f]*(sum ? models[i][f]/sum : 1/models.length)); models[i][f] = part; assigned += part; }
                }
            }
            // Per-model credits are not persisted in turnTokenTotals. Use token proportions,
            // explicitly estimated, while preserving the exact billed prompt total in integer nano-AIU.
            const weight = models.reduce((n,m)=>n+m.inputTokens+m.outputTokens,0);
            let assigned = 0;
            for (let i=0;i<models.length;i++) {
                models[i].nanoAiu = i === models.length-1 ? remainder.nanoAiu-assigned : Math.floor(remainder.nanoAiu*(weight ? (models[i].inputTokens+models[i].outputTokens)/weight : 1/models.length));
                assigned += models[i].nanoAiu;
            }
            remainder.modelUsage = models;
        }
        if (!known.length || remainder.nanoAiu || remainder.inputTokens || remainder.outputTokens || remainder.cachedTokens) { usage.push(remainder); }
        const total = meta.copilotUsage?.sessionTotalNanoAiu;
        if (typeof total === 'number' && Number.isFinite(total) && total >= 0) { savedSessionTotal = Math.max(savedSessionTotal ?? 0, total); }
        if (['partial', 'unavailable'].includes(meta.copilotUsage?.sessionAiCreditsStatus)) { notes.add('The backend marks session credits as incomplete.'); }
        if (!totals) { notes.add('Cumulative tokens were not saved; context-window counts are excluded.'); }
        if (meta.copilotUsage?.totalNanoAiu === undefined) { notes.add('Some saved turns have no measured credits; session cost is incomplete.'); }
    }
    const sidecar = dirs.map(dir => json(path.join(dir, 'vscode.requests.metadata.json'))).find(Array.isArray);
    for (const r of sidecar ?? []) {
        const id = r.copilotRequestId ?? r.vscodeRequestId;
        if (!id || usage.some(u => u.owner === id) || typeof r.creditsUsed !== 'number') { continue; }
        usage.push({ id: r.vscodeRequestId ?? id, eventId: r.copilotRequestId, owner: id, kind: 'saved', timestamp: users.get(id)?.ts, nanoAiu: Math.round(number(r.creditsUsed) * 1e9), inputTokens: 0, outputTokens: 0, cachedTokens: 0, model: r.responseModelId ?? selectedModel });
        notes.add('Legacy agent metadata contains credits only; token totals are unavailable.');
    }
    // Checkpoints are cumulative, not extra charges. Reconcile only their uncovered remainder.
    // A saved turn crossing a checkpoint cannot be split reliably; defer to a later checkpoint.
    snapshots.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    let previousTime = sessionStart;
    let previousTotal = 0;
    for (const snapshot of snapshots) {
        const end = snapshot.ts!;
        if (snapshot.total < previousTotal) { notes.add('Session credits reset or decreased; checkpoint deltas are not used across that boundary.'); previousTime = end; continue; }
        if (usage.some(u => u.kind === 'saved' && (u.intervalStart ?? u.timestamp) !== undefined && (u.intervalStart ?? u.timestamp)! <= end && (u.intervalEnd ?? u.timestamp)! > end)) { continue; }
        const covered = usage.filter(u => (u.intervalEnd ?? u.timestamp) !== undefined && (u.intervalEnd ?? u.timestamp)! <= end).reduce((n, u) => n + u.nanoAiu, 0);
        const missing = Math.max(0, snapshot.total - covered);
        if (missing) {
            usage.push({ id: `checkpoint:${end}`, kind: 'adjustment', timestamp: previousTime === undefined ? undefined : end, intervalStart: previousTime, intervalEnd: end,
                nanoAiu: missing, inputTokens: 0, outputTokens: 0, cachedTokens: 0, model: 'Unattributed usage' });
        }
        previousTime = end; previousTotal = snapshot.total;
    }
    const knownTotal = usage.reduce((n, u) => n + u.nanoAiu, 0);
    if (savedSessionTotal !== undefined && savedSessionTotal > knownTotal) {
        usage.push({ id: 'session-remainder', kind: 'adjustment', nanoAiu: savedSessionTotal - knownTotal, inputTokens: 0, outputTokens: 0, cachedTokens: 0, model: 'Unattributed usage' });
        notes.add('Some saved session credits cannot be assigned to a day.');
    }
    // Snapshot-only sessions can still expose their recorded cumulative token totals.
    if (!calls.size && !rows.length) {
        const latest = snapshots[snapshots.length - 1];
        const metrics = Object.entries<any>(latest?.data.modelMetrics ?? {});
        if (metrics.length) {
            usage.push({ id: 'snapshot-tokens', kind: 'saved', nanoAiu: 0,
                modelUsage: metrics.map(([model,m])=>({model,nanoAiu:0,inputTokens:number(m.usage?.inputTokens),outputTokens:number(m.usage?.outputTokens),cachedTokens:number(m.usage?.cacheReadTokens)})),
                inputTokens: metrics.reduce((n, [, m]) => n + number(m.usage?.inputTokens), 0),
                outputTokens: metrics.reduce((n, [, m]) => n + number(m.usage?.outputTokens), 0),
                cachedTokens: metrics.reduce((n, [, m]) => n + number(m.usage?.cacheReadTokens), 0),
                tokensKnown: true, model: metrics.length === 1 ? metrics[0][0] : 'Mixed models' });
        }
    }
    for (const [id, user] of users) {
        entries.push({ ts: user.ts, dur: 0, sid: sessionId, type: 'user_message', name: 'user_message', spanId: id, status: 'ok', attrs: { content: user.content } });
    }
    let undatedIndex = 0;
    for (const u of usage) {
        const owner = u.owner ?? u.id;
        const ts = u.timestamp ?? (++undatedIndex / 100);
        if (!users.has(owner)) {
            users.set(owner, { ts, content: '' });
            entries.push({ ts, dur: 0, sid: sessionId, type: 'user_message', name: 'user_message', spanId: owner, status: 'ok', attrs: { content: u.kind === 'adjustment' ? 'Other saved session usage' : 'Saved agent turn' } });
        }
        const d = u.detail ?? {};
        entries.push({ ts: d.startedAt ?? (u.kind === 'saved' ? u.intervalEnd ?? ts : ts) + 0.001, dur: number(d.duration), sid: sessionId, type: 'llm_request', name: u.kind === 'call' ? 'model_call' : 'saved_usage', spanId: u.id, parentSpanId: owner, status: 'ok', attrs: {
            modelDisplayName: typeof d.modelDisplayName === 'string' ? d.modelDisplayName : undefined, responseModel: d.responseModel, contextTier: d.contextTier, isByok: d.isByok, initiator: d.initiator,
            isAuto: typeof d.isAuto === 'boolean' ? d.isAuto : undefined, provider: d.provider?.id,
            tokensKnown: u.tokensKnown === true, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedTokens, copilotUsageNanoAiu: u.nanoAiu, responseId: u.id,
            userMessageId: owner, modelCallId: u.callKey, usageKind: u.kind, durationKnown: optionalNumber(d.duration) !== undefined, ttft: optionalNumber(d.timeToFirstTokenMs), contextKnown: false,
            cacheWriteTokens: optionalNumber(d.cacheWriteTokens), tokenDetails: Array.isArray(d.copilotUsage?.tokenDetails) ? d.copilotUsage.tokenDetails.filter((t: any) => typeof t.tokenType === 'string' && optionalNumber(t.tokenCount) !== undefined) : undefined, cacheExpiresAt: timestamp(d.cacheExpiresAt) ? d.cacheExpiresAt : undefined, reasoningTokens: optionalNumber(d.reasoningTokens), reasoningEffort: d.reasoningEffort,
            finishReason: d.finishReason, interTokenLatencyMs: optionalNumber(d.interTokenLatencyMs), maxPromptTokens: optionalNumber(d.maxPromptTokens), toolTokenCount: optionalNumber(d.toolTokenCount), availableToolCount: optionalNumber(d.availableToolCount),
            premiumRequests: optionalNumber(d.cost), agentId: d.agentId,
        } });
    }
    const metadata = dirs.map(dir => json(path.join(dir, 'vscode.metadata.json'))).find(Boolean);
    title = resolved.title ?? title ?? metadata?.customTitle ?? metadata?.title ?? [...users.values()].find(u => u.content.trim())?.content.replace(/\s+/g, ' ').trim().slice(0,100);
    if (!usage.length) { notes.add('No agent usage was persisted; zero totals do not mean free usage.'); }
    if (usage.some(u => u.timestamp === undefined)) { notes.add('Undated saved usage is excluded from daily and weekly totals.'); }
    if (usage.some(u => u.intervalStart !== undefined)) { notes.add('Checkpoint remainders are counted only in periods containing their entire interval.'); }
    if (!entries.length) { entries.push({ ts: 0, dur: 0, sid: sessionId, type: 'user_message', name: 'user_message', spanId: sessionId, status: 'ok', attrs: { content: 'Agent session (usage unavailable)' } }); }
    entries.sort((a, b) => a.ts - b.ts || (a.type === 'user_message' ? -1 : 1));
    return { modelSelections, routing, agents: [...agents.values()], permissionChecks: [...new Map(permissionChecks.map(c=>[`${c.id}:${c.failed}:${c.retry}`, c])).values()], catalog, sessionId, ownerSessionId: resolved.ownerSessionId, entries, usage, title, notes: [...notes], sessionNanoAiu: usage.reduce((n, u) => n + u.nanoAiu, 0), usageRecordCount: calls.size, ledgerTotals, unknownUsageEvents: [...unknownUsageEvents], hookDurationMs, compactionCount, codeChanges: snapshots[snapshots.length - 1]?.data.codeChanges ? { linesAdded: optionalNumber(snapshots[snapshots.length - 1].data.codeChanges.linesAdded), linesRemoved: optionalNumber(snapshots[snapshots.length - 1].data.codeChanges.linesRemoved), filesChanged: snapshots[snapshots.length - 1].data.codeChanges.filesModifiedCount } : undefined };
}
