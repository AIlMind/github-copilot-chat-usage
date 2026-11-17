import * as crypto from 'crypto';
import { ModelNames } from './modelNames';
import { filePathKey } from './sqliteSnapshot';
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { parseCreditDetailsNanoAiu, parseDebugLog } from './parser';
import { backgroundDependencies, hasRecordedTokenTotals, readBackgroundSession } from './background';

const SPEND_LOOKBACK_DAYS = 30;
const SPEND_FILE_CACHE_VERSION = 12;
const SPEND_FILE_CACHE_MAX_AGE_MS = (SPEND_LOOKBACK_DAYS + 14) * 24 * 60 * 60 * 1000;
const SPEND_FILE_CACHE_NAME = 'spend-file-cache.json';

export interface ChatSessionDirEntry {
    dir: string;
    workspaceKey: string;
    workspaceLabel: string;
}

export interface SpendBucketBase {
    estimated?: boolean;
    tokensKnown?: boolean;
    label: string;
    nanoAiu: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    requestCount: number;
    sessionCount: number;
}

export interface SpendBucket extends SpendBucketBase {
    unattributed?: SpendModelBucket;
    models?: SpendModelBucket[];
    workspaces?: SpendWorkspaceBucket[];
}

export interface SpendModelBucket extends SpendBucketBase {
    key: string;
}

export interface SpendWorkspaceBucket extends SpendBucketBase {
    key: string;
}

export interface SpendSummary {
    notes?: string[];
    undatedRequests?: number;
    today: SpendBucket;
    week?: SpendBucket;
    month?: SpendBucket;
    scannedFiles: number;
    generatedAt: number;
}

export interface SpendRequest {
    estimated?: boolean;
    modelDisplayName?: string;
    modelKey?: string;
    tokensKnown?: boolean;
    intervalStart?: number;
    sourcePriority?: number;
    inputIsContext?: boolean;
    timestamp?: number;
    nanoAiu: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    modelUsage?: SpendRequest[];
    model: string;
    dedupeKey?: string;
}

export type SpendScanMode = 'today' | 'full';

interface SpendModelAccumulator {
    modelBuckets: Map<string, SpendModelBucket>;
    modelSessionSets: Map<string, Set<string>>;
}

interface SpendWorkspaceAccumulator {
    workspaceBuckets: Map<string, SpendWorkspaceBucket>;
    workspaceSessionSets: Map<string, Set<string>>;
}

interface SpendFileCacheEntry {
    sessionId?: string;
    signature?: string;
    notes?: string[];
    parserVersion: number;
    path: string;
    mtimeMs: number;
    size: number;
    requests: SpendRequest[];
    parsedAt: number;
    lastSeenAt: number;
}

interface SpendFileCacheStore {
    version: number;
    entries: Record<string, SpendFileCacheEntry>;
}

interface ComputeSpendSummaryOptions {
    cacheFilePath?: string;
    now?: number;
    usageFiles?: UsageFile[];
    cliRoots?: string[];
    agentRoots?: string[];
}

export interface UsageFile extends ChatSessionDirEntry {
    file: string;
    sessionId: string;
    kind: 'debug' | 'background';
}

interface SpendRequestCandidate {
    request: SpendRequest & { timestamp: number };
    sessionKey: string;
    workspace: ChatSessionDirEntry;
}

function toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function parseCreditDetailsModel(detailsValue: unknown): string | undefined {
    if (typeof detailsValue !== 'string') {
        return undefined;
    }

    const match = detailsValue.match(/^\s*(.*?)\s*•\s*\d+(?:\.\d+)?\s+(?:ai\s+)?credits?\b/i);
    const model = match?.[1]?.trim();
    return model || undefined;
}

function normalizeSpendModel(modelValue: unknown): string | undefined {
    if (typeof modelValue !== 'string') {
        return undefined;
    }

    const model = modelValue.trim();
    if (!model) {
        return undefined;
    }

    return model.replace(/^copilot\//i, '');
}

function applySpendRequestModel(request: SpendRequest, modelValue: unknown): void {
    const model = normalizeSpendModel(modelValue);
    if (!model) {
        return;
    }

    if (request.model === 'Unknown model' || request.model === 'auto' || model !== 'auto') {
        request.model = model;
    }
}

function ensureSpendRequest(requests: Map<string, SpendRequest>, index: string): SpendRequest {
    let request = requests.get(index);
    if (!request) {
        request = {
            nanoAiu: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: 'Unknown model',
        };
        requests.set(index, request);
    }
    return request;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        const parsed = toFiniteNumber(value);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
}

function applySpendRequestTokens(request: SpendRequest, value: any): void {
    if (!value || typeof value !== 'object') {
        return;
    }

    const metadata = value.result?.metadata ?? value.metadata;
    const usage = metadata?.usage ?? value.usage;
    const inputTokens = firstFiniteNumber(
        usage?.inputTokens,
        usage?.input_tokens,
        value.promptTokens,
        value.inputTokens,
        value.prompt_tokens,
        value.input_tokens,
        metadata?.promptTokens,
        metadata?.inputTokens,
        metadata?.prompt_tokens,
        metadata?.input_tokens,
        usage?.promptTokens,
        usage?.inputTokens,
        usage?.prompt_tokens,
        usage?.input_tokens
    );
    const outputTokens = firstFiniteNumber(
        value.completionTokens,
        value.outputTokens,
        value.completion_tokens,
        value.output_tokens,
        metadata?.completionTokens,
        metadata?.outputTokens,
        metadata?.completion_tokens,
        metadata?.output_tokens,
        usage?.completionTokens,
        usage?.outputTokens,
        usage?.completion_tokens,
        usage?.output_tokens
    );

    if (inputTokens !== undefined) {
        request.inputTokens = inputTokens;
        request.inputIsContext = usage?.inputTokens === undefined && usage?.input_tokens === undefined &&
            (value.promptTokens !== undefined || metadata?.promptTokens !== undefined);
    }
    if (outputTokens !== undefined) {
        request.outputTokens = outputTokens;
    }
}

function normalizeSpendDedupeKey(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const key = value.trim();
    return key ? `response:${key}` : undefined;
}

function readSpendRequestDedupeKey(value: any): string | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const metadata = value.result?.metadata ?? value.metadata;
    const usage = metadata?.usage ?? value.usage;
    return normalizeSpendDedupeKey(
        metadata?.responseId ??
        metadata?.response_id ??
        usage?.responseId ??
        usage?.response_id ??
        value.result?.responseId ??
        value.result?.response_id ??
        value.responseId ??
        value.response_id
    );
}

function applySpendRequestDedupeKey(request: SpendRequest, value: any, overwrite = false): void {
    const key = readSpendRequestDedupeKey(value);
    if (key && (overwrite || !request.dedupeKey)) {
        request.dedupeKey = key;
    }
}

function readSpendRequestNanoAiu(value: any): number {
    if (!value || typeof value !== 'object') {
        return 0;
    }

    const metadata = value.result?.metadata ?? value.metadata;
    const usage = metadata?.usage ?? value.usage;
    const direct = firstFiniteNumber(
        value.copilotUsageNanoAiu,
        value.nanoAiu,
        value.nanoAiU,
        metadata?.copilotUsageNanoAiu,
        metadata?.nanoAiu,
        metadata?.nanoAiU,
        usage?.copilotUsageNanoAiu,
        usage?.nanoAiu,
        usage?.nanoAiU
    );
    if (direct !== undefined) {
        return direct;
    }

    return parseCreditDetailsNanoAiu(value.result?.details ?? value.details);
}

function applySpendRequestNanoAiu(request: SpendRequest, value: any): void {
    const nanoAiu = readSpendRequestNanoAiu(value);
    if (nanoAiu > 0) {
        request.nanoAiu = nanoAiu;
    }
}

function updateSpendRequestFromValue(requests: Map<string, SpendRequest>, index: string, value: any): void {
    if (!value || typeof value !== 'object') {
        return;
    }

    const request = ensureSpendRequest(requests, index);
    const timestamp = toFiniteNumber(value.timestamp);
    if (timestamp !== undefined) {
        request.timestamp = timestamp;
    }

    const details = value.result?.details ?? value.details;
    applySpendRequestDedupeKey(request, value, true);
    applySpendRequestNanoAiu(request, value);
    applySpendRequestModel(request, parseCreditDetailsModel(details) ?? value.modelId ?? value.model);
    applySpendRequestTokens(request, value);
}

function readSpendLines(filePath: string, onLine: (line: string) => void): void {
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, 'r');
        const decoder = new StringDecoder('utf8');
        const buffer = Buffer.alloc(64 * 1024);
        let carry = '';

        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                break;
            }

            carry += decoder.write(buffer.subarray(0, bytesRead));
            let newlineIndex = carry.indexOf('\n');
            while (newlineIndex >= 0) {
                onLine(carry.slice(0, newlineIndex));
                carry = carry.slice(newlineIndex + 1);
                newlineIndex = carry.indexOf('\n');
            }
        }

        carry += decoder.end();
        if (carry) {
            onLine(carry);
        }
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore close failures */ }
        }
    }
}

export function readSpendRequestsFromChatSession(filePath: string): SpendRequest[] {
    // Keep billing fields only. Hydrating entire responses would retain prompts, images and tool output.
    const projected = new Map<number, any>();
    let nextIndex = 0;
    const keys = new Set(['timestamp', 'requestId', 'modelId', 'model', 'promptTokens', 'inputTokens', 'prompt_tokens', 'input_tokens', 'completionTokens', 'outputTokens', 'completion_tokens', 'output_tokens', 'copilotUsageNanoAiu', 'nanoAiu', 'nanoAiU', 'responseId', 'response_id', 'usage', 'metadata', 'result']);
    const project = (request: any) => {
        const value: any = {};
        if (!request || typeof request !== 'object') { return value; }
        for (const key of keys) {
            if (key === 'result') {
                if (request.result) { value.result = { details: request.result.details, metadata: request.result.metadata }; }
            } else if (request[key] !== undefined) { value[key] = request[key]; }
        }
        return value;
    };
    const replace = (values: any[], from = 0) => {
        for (const key of projected.keys()) { if (key >= from) { projected.delete(key); } }
        values.forEach((r, i) => projected.set(from + i, project(r)));
        nextIndex = from + values.length;
    };
    try {
        readSpendLines(filePath, line => {
            if (!line.includes('requests')) { return; }
            let raw: any;
            try { raw = JSON.parse(line); } catch { return; }
            if (raw.kind === 0) { replace(Array.isArray(raw.v?.requests) ? raw.v.requests : []); return; }
            if (!Array.isArray(raw.k) || raw.k[0] !== 'requests') { return; }
            if (raw.k.length === 1) {
                if (raw.kind === 2 && Array.isArray(raw.v)) { replace(raw.v, toFiniteNumber(raw.i) ?? nextIndex); }
                else { replace(Array.isArray(raw.v) ? raw.v : []); }
                return;
            }
            const index = toFiniteNumber(raw.k[1]);
            if (index === undefined || index < 0) { return; }
            nextIndex = Math.max(nextIndex, index + 1);
            if (raw.k.length === 2) {
                if (raw.kind === 3) { projected.delete(index); }
                else { projected.set(index, project(raw.v)); }
                return;
            }
            if (!keys.has(raw.k[2])) { return; }
            if (raw.k[2] === 'result' && raw.k.length > 3 && !['details', 'metadata'].includes(raw.k[3])) { return; }
            const request = projected.get(index) ?? {};
            let cursor = request;
            const parts = raw.k.slice(2);
            for (const key of parts.slice(0, -1)) {
                if (!cursor[key] || typeof cursor[key] !== 'object') { cursor[key] = {}; }
                cursor = cursor[key];
            }
            const last = parts[parts.length - 1];
            if (raw.kind === 3) { delete cursor[last]; }
            else { cursor[last] = raw.v; }
            projected.set(index, project(request));
        });
    } catch { return []; }
    const requests = new Map<string, SpendRequest>();
    for (const [index, raw] of projected) { updateSpendRequestFromValue(requests, String(index), raw); }
    return [...requests.values()].filter(r => r.nanoAiu > 0 || r.inputTokens > 0 || r.outputTokens > 0);
}

function createSpendBucket(label: string): SpendBucket {
    return { label, tokensKnown: true, nanoAiu: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requestCount: 0, sessionCount: 0 };
}

function createSpendModelBucket(key: string, label: string): SpendModelBucket {
    return { key, ...createSpendBucket(label) };
}

function createSpendWorkspaceBucket(key: string, label: string): SpendWorkspaceBucket {
    return { key, ...createSpendBucket(label) };
}

function createSpendModelAccumulator(): SpendModelAccumulator {
    return {
        modelBuckets: new Map<string, SpendModelBucket>(),
        modelSessionSets: new Map<string, Set<string>>(),
    };
}

function createSpendWorkspaceAccumulator(): SpendWorkspaceAccumulator {
    return {
        workspaceBuckets: new Map<string, SpendWorkspaceBucket>(),
        workspaceSessionSets: new Map<string, Set<string>>(),
    };
}

function addToSpendBucket(bucket: SpendBucketBase, request: SpendRequest, sessionSet: Set<string>, sessionId: string): void {
    bucket.estimated ||= request.estimated;
    bucket.tokensKnown = bucket.tokensKnown !== false && request.tokensKnown !== false;
    bucket.nanoAiu += request.nanoAiu;
    bucket.inputTokens += request.inputTokens;
    bucket.outputTokens += request.outputTokens;
    bucket.cachedTokens += request.cachedTokens ?? 0;
    bucket.requestCount++;
    sessionSet.add(sessionId);
    bucket.sessionCount = sessionSet.size;
}

function addToSpendModelBucket(
    buckets: Map<string, SpendModelBucket>,
    sessionSets: Map<string, Set<string>>,
    key: string,
    label: string,
    request: SpendRequest,
    sessionId: string
): void {
    let bucket = buckets.get(key);
    if (!bucket) {
        bucket = createSpendModelBucket(key, label);
        buckets.set(key, bucket);
    }

    let sessionSet = sessionSets.get(key);
    if (!sessionSet) {
        sessionSet = new Set<string>();
        sessionSets.set(key, sessionSet);
    }

    addToSpendBucket(bucket, request, sessionSet, sessionId);
}

function sortedSpendModelBuckets(buckets: Map<string, SpendModelBucket>): SpendModelBucket[] {
    return [...buckets.values()].sort((a, b) => {
        if (b.nanoAiu !== a.nanoAiu) {
            return b.nanoAiu - a.nanoAiu;
        }
        return a.label.localeCompare(b.label);
    });
}

function sortedSpendWorkspaceBuckets(buckets: Map<string, SpendWorkspaceBucket>): SpendWorkspaceBucket[] {
    return [...buckets.values()].sort((a, b) => {
        if (b.nanoAiu !== a.nanoAiu) {
            return b.nanoAiu - a.nanoAiu;
        }
        return a.label.localeCompare(b.label);
    });
}

function addToSpendModels(accumulator: SpendModelAccumulator, request: SpendRequest, sessionId: string): void {
    if (request.modelUsage?.length) {
        request.modelUsage.forEach(usage => addToSpendModels(accumulator, usage, sessionId));
        return;
    }
    addToSpendModelBucket(
        accumulator.modelBuckets,
        accumulator.modelSessionSets,
        request.modelKey ?? request.model,
        request.model,
        request,
        sessionId
    );
}

function addToSpendWorkspaces(
    accumulator: SpendWorkspaceAccumulator,
    request: SpendRequest,
    sessionId: string,
    workspace: ChatSessionDirEntry
): void {
    let bucket = accumulator.workspaceBuckets.get(workspace.workspaceKey);
    if (!bucket) {
        bucket = createSpendWorkspaceBucket(workspace.workspaceKey, workspace.workspaceLabel);
        accumulator.workspaceBuckets.set(workspace.workspaceKey, bucket);
    }

    let sessionSet = accumulator.workspaceSessionSets.get(workspace.workspaceKey);
    if (!sessionSet) {
        sessionSet = new Set<string>();
        accumulator.workspaceSessionSets.set(workspace.workspaceKey, sessionSet);
    }

    addToSpendBucket(bucket, request, sessionSet, sessionId);
}

function shouldReplaceSpendCandidate(existing: SpendRequestCandidate, candidate: SpendRequestCandidate): boolean {
    if ((candidate.request.sourcePriority ?? 0) !== (existing.request.sourcePriority ?? 0)) {
        return (candidate.request.sourcePriority ?? 0) > (existing.request.sourcePriority ?? 0);
    }
    if (candidate.request.timestamp !== existing.request.timestamp) {
        return candidate.request.timestamp < existing.request.timestamp;
    }

    return candidate.sessionKey.localeCompare(existing.sessionKey) < 0;
}

function debugSpendRequests(file: string): SpendRequest[] {
    const summary = parseDebugLog(file);
    if (!summary) { return []; }
    return summary.userMessages.flatMap(message => {
        // Continuations can be merged into one visible message while retaining separate
        // response ids in chatSessions. Reconcile those billing identities individually.
        const groups = new Map<string, { request: SpendRequest; models: Map<string, SpendRequest> }>();
        for (const turn of message.modelTurns) {
            const key = turn.responseId ? `response:${turn.responseId}` : `session:${summary.sessionId}:${message.timestamp}`;
            let group = groups.get(key);
            if (!group) {
                const continuation = [...message.mergedMessages].reverse().find(m => m.timestamp <= turn.timestamp);
                group = {
                    request: { timestamp: continuation?.timestamp ?? message.timestamp, nanoAiu: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, model: 'Unknown model', sourcePriority: 2, dedupeKey: key },
                    models: new Map(),
                };
                groups.set(key, group);
            }
            const collect = (turns: typeof message.modelTurns) => {
                for (const t of turns) {
                    const model = group!.models.get(t.model) ?? { model: t.model, modelDisplayName:t.modelDisplayName, nanoAiu: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
                    for (const target of [group!.request, model]) {
                        target.nanoAiu += t.nanoAiu;
                        target.inputTokens += t.inputTokens;
                        target.outputTokens += t.outputTokens;
                        target.cachedTokens! += t.cachedTokens;
                    }
                    group!.models.set(t.model, model);
                    for (const tool of t.toolCalls) {
                        for (const child of tool.subagentSummary?.userMessages ?? []) { collect(child.modelTurns); }
                    }
                }
            };
            collect([turn]);
        }
        return [...groups.values()].map(({ request, models }) => ({ ...request, model: models.size === 1 ? [...models.keys()][0] : 'Mixed models', modelUsage: [...models.values()] }));
    });
}

/** Include WAL and child logs: their bytes can change while the parent file stays untouched. */
function usageFileState(file: UsageFile, cliRoots: string[] = [], agentRoots: string[] = []): {signature:string; modifiedTime:number} {
    let dependencies: string[];
    if (file.kind === 'background') { dependencies = backgroundDependencies(file.file, cliRoots, agentRoots); }
    else {
        try { dependencies = fs.readdirSync(path.dirname(file.file)).filter(n => n.endsWith('.jsonl')).map(n => path.join(path.dirname(file.file), n)); }
        catch { dependencies = [file.file]; }
    }
    const files = new Map(dependencies.map(f=>[filePathKey(f),f]));
    let modifiedTime = 0;
    const signature = [...files].sort(([a],[b])=>a.localeCompare(b)).map(([key,f]) => {
        try { const stat=fs.statSync(f,{bigint:true}); modifiedTime=Math.max(modifiedTime,Number(stat.mtimeMs)); return `${key}:${stat.ino}:${stat.size}:${stat.mtimeNs}`; }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } return `${key}:missing`; }
    }).join('|');
    return {signature,modifiedTime};
}
export function usageFileSignature(file: UsageFile, cliRoots: string[] = [], agentRoots: string[] = []): string {
    return usageFileState(file,cliRoots,agentRoots).signature;
}

function collectSpendCandidate(
    dedupedCandidates: Map<string, SpendRequestCandidate>,
    undedupedCandidates: SpendRequestCandidate[],
    candidate: SpendRequestCandidate
): void {
    if (!candidate.request.dedupeKey) {
        undedupedCandidates.push(candidate);
        return;
    }

    const existing = dedupedCandidates.get(candidate.request.dedupeKey);
    if (!existing || shouldReplaceSpendCandidate(existing, candidate)) {
        dedupedCandidates.set(candidate.request.dedupeKey, candidate);
    }
}

function finalizeSpendModels(accumulator: SpendModelAccumulator): SpendModelBucket[] {
    return sortedSpendModelBuckets(accumulator.modelBuckets).filter(b => b.key !== 'unattributed-usage');
}

function finalizeSpendWorkspaces(accumulator: SpendWorkspaceAccumulator): SpendWorkspaceBucket[] {
    return sortedSpendWorkspaceBuckets(accumulator.workspaceBuckets);
}

function createSpendFileCacheStore(): SpendFileCacheStore {
    return { version: SPEND_FILE_CACHE_VERSION, entries: {} };
}

export function getSpendFileCachePath(globalStoragePath: string | undefined): string | undefined {
    return globalStoragePath ? path.join(globalStoragePath, SPEND_FILE_CACHE_NAME) : undefined;
}

function normalizedCachePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    return filePathKey(resolved);
}

function spendFileCacheKey(filePath: string): string {
    return crypto.createHash('sha256').update(normalizedCachePath(filePath)).digest('hex');
}

function readSpendFileCache(cacheFilePath: string | undefined): SpendFileCacheStore {
    if (!cacheFilePath) {
        return createSpendFileCacheStore();
    }

    try {
        const raw = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
        if (raw?.version !== SPEND_FILE_CACHE_VERSION || !raw.entries || typeof raw.entries !== 'object') {
            return createSpendFileCacheStore();
        }
        return { version: SPEND_FILE_CACHE_VERSION, entries: raw.entries };
    } catch {
        return createSpendFileCacheStore();
    }
}

function writeSpendFileCache(cacheFilePath: string | undefined, store: SpendFileCacheStore): void {
    if (!cacheFilePath) {
        return;
    }

    const lock = `${cacheFilePath}.lock`;
    let acquired = false;
    let tempFile: string | undefined;
    try {
        fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
        try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); acquired = true; }
        catch (error) {
            // Leave a live writer alone; recover only locks left by a crashed process.
            if (error.code === 'EEXIST' && Date.now() - fs.statSync(lock).mtimeMs > 120_000) { fs.rmSync(lock, { force: true }); }
            return;
        }
        const merged = readSpendFileCache(cacheFilePath);
        for (const [key, entry] of Object.entries(store.entries)) {
            if (!merged.entries[key] || entry.parsedAt >= merged.entries[key].parsedAt) { merged.entries[key] = entry; }
        }
        tempFile = `${cacheFilePath}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(merged), { mode: 0o600 });
        fs.renameSync(tempFile, cacheFilePath);
    } catch {
        // The cache is only an optimization; spend summaries can still be recomputed.
    } finally {
        if (tempFile) { try { fs.rmSync(tempFile, { force: true }); } catch {} }
        if (acquired) { try { fs.rmSync(lock, { force: true }); } catch {} }
    }
}

function getCachedSpendRequests(
    store: SpendFileCacheStore,
    filePath: string,
    stat: fs.Stats
): SpendRequest[] | undefined {
    const entry = store.entries[spendFileCacheKey(filePath)];
    if (!entry || entry.parserVersion !== SPEND_FILE_CACHE_VERSION) {
        return undefined;
    }

    if (
        entry.path !== normalizedCachePath(filePath) ||
        entry.mtimeMs !== stat.mtimeMs ||
        entry.size !== stat.size ||
        !Array.isArray(entry.requests)
    ) {
        return undefined;
    }

    return entry.requests;
}

function updateSpendFileCache(
    store: SpendFileCacheStore,
    filePath: string,
    stat: fs.Stats,
    requests: SpendRequest[],
    now: number
): void {
    store.entries[spendFileCacheKey(filePath)] = {
        parserVersion: SPEND_FILE_CACHE_VERSION,
        path: normalizedCachePath(filePath),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        requests,
        parsedAt: now,
        lastSeenAt: now,
    };
}

function pruneSpendFileCache(store: SpendFileCacheStore, now: number): boolean {
    let changed = false;
    for (const [key, entry] of Object.entries(store.entries)) {
        const lastSeenAt = toFiniteNumber(entry?.lastSeenAt) ?? toFiniteNumber(entry?.parsedAt) ?? 0;
        if (now - lastSeenAt > SPEND_FILE_CACHE_MAX_AGE_MS) {
            delete store.entries[key];
            changed = true;
        }
    }
    return changed;
}

export function computeSpendSummaryFromChatSessionDirs(
    mode: SpendScanMode,
    chatSessionDirs: ChatSessionDirEntry[],
    options: ComputeSpendSummaryOptions = {}
): SpendSummary {
    const now = options.now ?? Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayCutoff = todayStart.getTime();
    const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;
    const monthCutoff = now - SPEND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const includeHistory = mode === 'full';

    const summary: SpendSummary = {
        today: createSpendBucket('Today'),
        week: includeHistory ? createSpendBucket('Last 7 days') : undefined,
        month: includeHistory ? createSpendBucket('Last 30 days') : undefined,
        scannedFiles: 0,
        generatedAt: now,
    };
    const todaySessions = new Set<string>();
    const weekSessions = new Set<string>();
    const monthSessions = new Set<string>();
    const todayWorkspaces = createSpendWorkspaceAccumulator();
    const weekWorkspaces = createSpendWorkspaceAccumulator();
    const monthWorkspaces = createSpendWorkspaceAccumulator();
    const todayModels = createSpendModelAccumulator();
    const weekModels = createSpendModelAccumulator();
    const monthModels = createSpendModelAccumulator();
    const fileCutoff = includeHistory ? monthCutoff : todayCutoff;
    const fileCache = readSpendFileCache(options.cacheFilePath);
    const dedupedCandidates = new Map<string, SpendRequestCandidate>();
    const undedupedCandidates: SpendRequestCandidate[] = [];
    let fileCacheChanged = false;
    const notes = new Set<string>();
    const preferredSessions = new Map<string, number>();
    const seenFiles = new Set<string>();
    const selectedSources = new Map<string, { source: UsageFile; requests: SpendRequest[]; priority: number }>();
    // Background rows already include child usage. Select one representation per session
    // before considering debug/transcript fallbacks; never add an inclusive parent twice.
    const usageFiles = [...(options.usageFiles ?? [])].sort((a, b) => (a.kind === 'background' ? 0 : 1) - (b.kind === 'background' ? 0 : 1));
    for (const source of usageFiles) {
        let real: string;
        let stat: fs.Stats;
        try { real = fs.realpathSync(source.file); stat = fs.statSync(real); } catch { continue; }
        if (seenFiles.has(real)) { continue; }
        seenFiles.add(real);
        const state = usageFileState(source, options.cliRoots, options.agentRoots);
        if (Math.max(stat.mtimeMs,state.modifiedTime) < fileCutoff) { continue; }
        const signature = state.signature;
        const key = spendFileCacheKey(real);
        const cached = fileCache.entries[key];
        let requests: SpendRequest[];
        let canonicalSessionId = source.sessionId;
        if (cached?.signature === signature && cached.parserVersion === SPEND_FILE_CACHE_VERSION) {
            requests = cached.requests;
            canonicalSessionId = cached.sessionId ?? canonicalSessionId;
            for (const note of cached.notes ?? []) { notes.add(note); }
        } else {
            let sourceNotes: string[] = [];
            if (source.kind === 'background') {
                const data = readBackgroundSession(real, options.cliRoots, options.agentRoots);
                sourceNotes = data.notes;
                canonicalSessionId = data.sessionId;
                const sourcePriority = hasRecordedTokenTotals(data) ? 3 : 1;
                requests = data.usage.map(u => ({
                    modelUsage: u.modelUsage,
                    timestamp: u.timestamp, intervalStart: u.intervalStart, nanoAiu: u.nanoAiu,
                    modelDisplayName: u.detail?.modelDisplayName, tokensKnown: u.tokensKnown === true, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedTokens, model: u.model,
                    sourcePriority,
                    dedupeKey: `background:${data.sessionId}:${crypto.createHash('sha256').update(u.kind === 'saved' ? `saved:${u.id}` : u.eventId ?? u.id).digest('hex')}`,
                }));
            } else { requests = debugSpendRequests(real); }
            if (sourceNotes.some(n => /unavailable or unreadable/.test(n)) && cached?.parserVersion === SPEND_FILE_CACHE_VERSION) {
                requests = cached.requests;
                sourceNotes.push('Using the last readable saved usage while the agent database is busy.');
            }
            updateSpendFileCache(fileCache, real, stat, requests, now);
            // A changing or unreadable source must be retried, never frozen in the cache.
            fileCache.entries[key].signature = sourceNotes.some(n => /unavailable or unreadable/.test(n)) || usageFileSignature(source, options.cliRoots, options.agentRoots) !== signature ? undefined : signature;
            fileCache.entries[key].sessionId = canonicalSessionId;
            fileCache.entries[key].notes = sourceNotes;
            sourceNotes.forEach(n => notes.add(n));
            fileCacheChanged = true;
        }
        summary.scannedFiles++;
        if (!requests.length) { continue; }
        const priority = requests[0].sourcePriority ?? 0;
        const selected = selectedSources.get(canonicalSessionId);
        if (!selected || priority > selected.priority) { selectedSources.set(canonicalSessionId, { source: { ...source, sessionId: canonicalSessionId }, requests: [...requests], priority }); }
        else if (priority === selected.priority) { selected.requests.push(...requests); }
    }
    for (const { source, requests, priority } of selectedSources.values()) {
        if (source.kind === 'background' || requests.some(r => !r.dedupeKey?.startsWith('response:'))) { preferredSessions.set(source.sessionId, priority); }
        const unique = new Map(requests.map((request, i) => [request.dedupeKey ?? `index:${i}`, request]));
        for (const request of unique.values()) {
            if (request.timestamp === undefined) { summary.undatedRequests = (summary.undatedRequests ?? 0) + 1; continue; }
            collectSpendCandidate(dedupedCandidates, undedupedCandidates, { request: request as SpendRequest & { timestamp: number }, sessionKey: source.sessionId, workspace: source });
        }
    }

    for (const chatDir of chatSessionDirs) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(chatDir.dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }

            const filePath = path.join(chatDir.dir, entry.name);
            const sessionId = path.basename(entry.name, '.jsonl');
            if (preferredSessions.has(sessionId)) { continue; }
            let stat: fs.Stats;
            try {
                const real = fs.realpathSync(filePath);
                if (seenFiles.has(real)) { continue; }
                seenFiles.add(real);
                stat = fs.statSync(filePath);
            } catch {
                continue;
            }
            if (stat.mtimeMs < fileCutoff) {
                continue;
            }

            summary.scannedFiles++;
            const sessionKey = sessionId;
            let requests = getCachedSpendRequests(fileCache, filePath, stat);
            if (!requests) {
                requests = readSpendRequestsFromChatSession(filePath);
                updateSpendFileCache(fileCache, filePath, stat, requests, now);
                fileCacheChanged = true;
            }

            for (const request of requests) {
                if (request.timestamp === undefined) {
                    continue;
                }

                if (request.inputIsContext) { notes.add('Transcript context-window input counts are excluded from cumulative tokens.'); }
                collectSpendCandidate(dedupedCandidates, undedupedCandidates, {
                    request: { ...request, inputTokens: request.inputIsContext ? 0 : request.inputTokens } as SpendRequest & { timestamp: number },
                    sessionKey,
                    workspace: chatDir,
                });
            }
        }
    }

    const candidates = [...dedupedCandidates.values(), ...undedupedCandidates];
    const modelNames = new ModelNames();
    const learnModels = (request: SpendRequest) => { modelNames.learn(request.model, request.modelDisplayName); request.modelUsage?.forEach(learnModels); };
    const resolveModels = (request: SpendRequest): SpendRequest => {
        const model = modelNames.resolve(request.model);
        if (request.nanoAiu === 0 && /^gpt-4o-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(model.key)) { model.key = 'utility-no-charge'; model.label = 'Utility (no recorded charge)'; }
        return { ...request, model: model.label, modelKey: model.key, modelUsage: request.modelUsage?.map(resolveModels) };
    };
    candidates.forEach(c => learnModels(c.request));
    for (const candidate of candidates) {
        const { sessionKey, workspace } = candidate;
        const request = resolveModels(candidate.request) as SpendRequest & { timestamp: number };
        const timestamp = request.timestamp;
        if (timestamp > now) { continue; }
        if ((request.intervalStart ?? timestamp) >= todayCutoff) {
            addToSpendBucket(summary.today, request, todaySessions, sessionKey);
            addToSpendWorkspaces(todayWorkspaces, request, sessionKey, workspace);
            addToSpendModels(todayModels, request, sessionKey);
        }
        if (includeHistory && summary.week && summary.month) {
            if ((request.intervalStart ?? timestamp) >= monthCutoff) {
                addToSpendBucket(summary.month, request, monthSessions, sessionKey);
                addToSpendWorkspaces(monthWorkspaces, request, sessionKey, workspace);
                addToSpendModels(monthModels, request, sessionKey);
            }
            if ((request.intervalStart ?? timestamp) >= weekCutoff) {
                addToSpendBucket(summary.week, request, weekSessions, sessionKey);
                addToSpendWorkspaces(weekWorkspaces, request, sessionKey, workspace);
                addToSpendModels(weekModels, request, sessionKey);
            }
        }
    }

    summary.notes = [...notes];
    summary.today.workspaces = finalizeSpendWorkspaces(todayWorkspaces);
    summary.today.models = finalizeSpendModels(todayModels);
    summary.today.unattributed = todayModels.modelBuckets.get('unattributed-usage');
    if (includeHistory) {
        if (summary.week) {
            summary.week.workspaces = finalizeSpendWorkspaces(weekWorkspaces);
            summary.week.models = finalizeSpendModels(weekModels);
            summary.week.unattributed = weekModels.modelBuckets.get('unattributed-usage');
        }
        if (summary.month) {
            summary.month.workspaces = finalizeSpendWorkspaces(monthWorkspaces);
            summary.month.models = finalizeSpendModels(monthModels);
            summary.month.unattributed = monthModels.modelBuckets.get('unattributed-usage');
        }
    }

    if (pruneSpendFileCache(fileCache, now)) {
        fileCacheChanged = true;
    }
    if (fileCacheChanged) {
        writeSpendFileCache(options.cacheFilePath, fileCache);
    }

    return summary;
}
