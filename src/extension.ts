import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    ToolCallSummary,
    ModelTurnSummary,
    MergedMessageInfo,
    UserMessageSummary,
    SessionSummary,
    ToolDefinitionSize,
    findSiblingChatSessionLog,
    NANO_AIU_PER_AIC,
    parseCreditDetailsNanoAiu,
    parseCopilotSessionFile,
    quickPeekHasBillingData,
    formatNumber,
    formatAic,
    formatDuration,
    estimateTokens,
} from './parser';
import { setCurrentGraph, registerChatParticipant } from './participant';

/**
 * Title priority levels (higher = better):
 * 5: customTitle from chatSessions metadata
 * 4: AI-generated title from title-* files in debug-logs
 * 2: First user message content
 * 1: debugName from debug-log attrs
 * 0: Fallback (sessionId prefix)
 */
interface TitleEntry {
    title: string;
    priority: number;
}

const AI_CREDITS_DOCS_URI = vscode.Uri.parse('https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals');
const DEBUG_LOGS_SETTING = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';
const INITIAL_PICK_DAYS = 3;
const PICK_LOAD_MORE_DAYS = 10;
const DEBUG_DIR_CACHE_MS = 30_000;
const SPEND_LOOKBACK_DAYS = 30;
const SPEND_SCAN_CACHE_MS = 30_000;
const SPEND_AUTO_REFRESH_MS = 5 * 60 * 1000;
const TITLE_CHAT_TAIL_BYTES = 256 * 1024;
const TITLE_DEBUG_HEAD_BYTES = 16 * 1024;

interface SessionCandidate {
    id: string;
    mainJsonl: string;
    chatSessionJsonl?: string;
    modifiedTime: number;
}

interface SessionScanResult<T extends SessionCandidate = SessionCandidate> {
    sessions: T[];
    hasOlder: boolean;
}

interface ChatSessionDirEntry {
    dir: string;
    workspaceKey: string;
    workspaceLabel: string;
}

interface SpendBucketBase {
    label: string;
    nanoAiu: number;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
    sessionCount: number;
}

interface SpendBucket extends SpendBucketBase {
    models?: SpendModelBucket[];
    workspaces?: SpendWorkspaceBucket[];
}

interface SpendModelBucket extends SpendBucketBase {
    key: string;
}

interface SpendWorkspaceBucket extends SpendBucketBase {
    key: string;
    models?: SpendModelBucket[];
}

interface SpendSummary {
    today: SpendBucket;
    week?: SpendBucket;
    month?: SpendBucket;
    scannedFiles: number;
    generatedAt: number;
}

interface SpendRequest {
    timestamp?: number;
    nanoAiu: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
}

interface SpendModelAccumulator {
    modelBuckets: Map<string, SpendModelBucket>;
    modelSessionSets: Map<string, Set<string>>;
}

interface SpendWorkspaceAccumulator {
    workspaceBuckets: Map<string, SpendWorkspaceBucket>;
    workspaceSessionSets: Map<string, Set<string>>;
    workspaceModels: Map<string, SpendModelAccumulator>;
}

function pathExists(candidate: string | undefined): candidate is string {
    return !!candidate && fs.existsSync(candidate);
}

function pushUnique(items: string[], value: string | undefined): void {
    if (!value || items.includes(value)) { return; }
    items.push(value);
}

function formatUsdEstimate(nanoAiu: number): string {
    if (nanoAiu <= 0) {
        return '$0.00 USD est.';
    }

    const aic = nanoAiu / NANO_AIU_PER_AIC;
    const usd = aic / 100;
    return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)} USD est.`;
}

function isDebugLogsSettingEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(DEBUG_LOGS_SETTING) === true;
}

function getWorkspaceStorageRoots(): string[] {
    const roots: string[] = [];
    const appDataPath = process.env.APPDATA;
    const home = process.env.HOME;
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || (home ? path.join(home, '.config') : undefined);

    if (appDataPath) {
        pushUnique(roots, path.join(appDataPath, 'Code', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(appDataPath, 'Code - Insiders', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(appDataPath, 'VSCodium', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(appDataPath, 'Cursor', 'User', 'workspaceStorage'));
    }

    if (home) {
        const macConfigRoot = path.join(home, 'Library', 'Application Support');
        pushUnique(roots, path.join(macConfigRoot, 'Code', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(macConfigRoot, 'Code - Insiders', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(macConfigRoot, 'VSCodium', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(macConfigRoot, 'Cursor', 'User', 'workspaceStorage'));
    }

    if (xdgConfigHome) {
        pushUnique(roots, path.join(xdgConfigHome, 'Code', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(xdgConfigHome, 'Code - Insiders', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(xdgConfigHome, 'VSCodium', 'User', 'workspaceStorage'));
        pushUnique(roots, path.join(xdgConfigHome, 'Cursor', 'User', 'workspaceStorage'));
    }

    return roots.filter(pathExists);
}

function getConfiguredSearchRoots(): string[] {
    return vscode.workspace
        .getConfiguration('copilotUsageTracker')
        .get<string[]>('searchRoots', [])
        .filter(pathExists);
}

function collectDebugLogDirs(root: string, maxDepth: number, results: Set<string>): void {
    if (maxDepth < 0 || !fs.existsSync(root)) { return; }

    if (path.basename(root) === 'debug-logs') {
        results.add(root);
        return;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const child = path.join(root, entry.name);

        if (entry.name === 'GitHub.copilot-chat') {
            const debugLogsDir = path.join(child, 'debug-logs');
            if (fs.existsSync(debugLogsDir)) {
                results.add(debugLogsDir);
            }
            continue;
        }

        collectDebugLogDirs(child, maxDepth - 1, results);
    }
}

function collectChatSessionDirs(root: string, maxDepth: number, results: Set<string>): void {
    if (maxDepth < 0 || !fs.existsSync(root)) { return; }

    const base = path.basename(root);
    if (base === 'chatSessions' || base === 'emptyWindowChatSessions') {
        results.add(root);
        return;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const child = path.join(root, entry.name);
        if (entry.name === 'chatSessions' || entry.name === 'emptyWindowChatSessions') {
            results.add(child);
            continue;
        }
        collectChatSessionDirs(child, maxDepth - 1, results);
    }
}

function labelFromPath(filePath: string | undefined): string | undefined {
    if (!filePath) { return undefined; }

    const trimmed = filePath.replace(/[\\/]+$/, '');
    const base = path.basename(trimmed);
    if (!base || base === '.' || base === path.sep) {
        return undefined;
    }

    return base.toLowerCase().endsWith('.code-workspace')
        ? base.slice(0, -'.code-workspace'.length)
        : base;
}

function fsPathFromUriString(value: string | undefined): string | undefined {
    if (!value) { return undefined; }

    try {
        const uri = vscode.Uri.parse(value);
        if (uri.scheme === 'file') {
            return uri.fsPath;
        }
        if (uri.path) {
            return decodeURIComponent(uri.path);
        }
    } catch {
        // Fall back to treating the value as a path below.
    }

    return value;
}

function labelFromWorkspaceFolder(folder: any, workspaceFilePath: string): string | undefined {
    if (!folder || typeof folder !== 'object') {
        return undefined;
    }

    if (typeof folder.name === 'string' && folder.name.trim()) {
        return folder.name.trim();
    }

    if (typeof folder.uri === 'string') {
        return labelFromPath(fsPathFromUriString(folder.uri));
    }

    if (typeof folder.path === 'string' && folder.path.trim()) {
        const folderPath = path.isAbsolute(folder.path)
            ? folder.path
            : path.resolve(path.dirname(workspaceFilePath), folder.path);
        return labelFromPath(folderPath);
    }

    return undefined;
}

function readWorkspaceFileLabel(workspaceFilePath: string | undefined): string | undefined {
    if (!workspaceFilePath || !fs.existsSync(workspaceFilePath)) {
        return undefined;
    }

    try {
        const workspace = JSON.parse(fs.readFileSync(workspaceFilePath, 'utf-8'));
        const folders = Array.isArray(workspace.folders)
            ? workspace.folders
                .map((folder: any) => labelFromWorkspaceFolder(folder, workspaceFilePath))
                .filter((label: string | undefined): label is string => !!label)
            : [];

        if (folders.length === 1) {
            return folders[0];
        }
        if (folders.length > 1) {
            return `${folders[0]} +${folders.length - 1}`;
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function resolveWorkspaceStorageLabel(workspaceStorageDir: string): string {
    const cached = workspaceLabelCache.get(workspaceStorageDir);
    if (cached) {
        return cached;
    }

    const fallback = path.basename(workspaceStorageDir).slice(0, 8) || 'Unknown Workspace';
    let label: string | undefined;
    const workspaceJson = path.join(workspaceStorageDir, 'workspace.json');

    try {
        const workspace = JSON.parse(fs.readFileSync(workspaceJson, 'utf-8'));
        if (typeof workspace.folder === 'string') {
            label = labelFromPath(fsPathFromUriString(workspace.folder));
        }

        if (!label && typeof workspace.workspace === 'string') {
            const workspacePath = fsPathFromUriString(workspace.workspace);
            label = readWorkspaceFileLabel(workspacePath) || labelFromPath(workspacePath);
            if (label === 'workspace.json') {
                label = undefined;
            }
        }
    } catch {
        label = undefined;
    }

    const resolved = label || fallback;
    workspaceLabelCache.set(workspaceStorageDir, resolved);
    return resolved;
}

function chatSessionDirEntry(dir: string): ChatSessionDirEntry {
    const resolvedDir = path.resolve(dir);
    const base = path.basename(resolvedDir);

    if (base === 'emptyWindowChatSessions') {
        return {
            dir: resolvedDir,
            workspaceKey: resolvedDir,
            workspaceLabel: 'Empty Window',
        };
    }

    if (base === 'chatSessions') {
        const workspaceStorageDir = path.dirname(resolvedDir);
        return {
            dir: resolvedDir,
            workspaceKey: workspaceStorageDir,
            workspaceLabel: resolveWorkspaceStorageLabel(workspaceStorageDir),
        };
    }

    return {
        dir: resolvedDir,
        workspaceKey: resolvedDir,
        workspaceLabel: labelFromPath(path.dirname(resolvedDir)) || labelFromPath(resolvedDir) || 'Unknown Workspace',
    };
}

function addChatSessionDir(results: Map<string, ChatSessionDirEntry>, dir: string): void {
    const entry = chatSessionDirEntry(dir);
    if (!results.has(entry.dir)) {
        results.set(entry.dir, entry);
    }
}

function findAllChatSessionDirs(refresh = false): ChatSessionDirEntry[] {
    if (!refresh && chatSessionDirsCache && chatSessionDirsCache.expiresAt > Date.now()) {
        return chatSessionDirsCache.dirs;
    }

    const results = new Map<string, ChatSessionDirEntry>();
    for (const wsStorageRoot of getWorkspaceStorageRoots()) {
        let workspaceDirs: string[];
        try {
            workspaceDirs = fs.readdirSync(wsStorageRoot);
        } catch {
            continue;
        }

        for (const dir of workspaceDirs) {
            const chatSessionsDir = path.join(wsStorageRoot, dir, 'chatSessions');
            if (fs.existsSync(chatSessionsDir)) {
                addChatSessionDir(results, chatSessionsDir);
            }
        }

        const userRoot = path.dirname(wsStorageRoot);
        const emptyWindowDir = path.join(userRoot, 'globalStorage', 'emptyWindowChatSessions');
        if (fs.existsSync(emptyWindowDir)) {
            addChatSessionDir(results, emptyWindowDir);
        }
    }

    const maxDepth = vscode.workspace
        .getConfiguration('copilotUsageTracker')
        .get<number>('maxSearchDepth', 6);
    for (const root of getConfiguredSearchRoots()) {
        const configuredDirs = new Set<string>();
        collectChatSessionDirs(root, maxDepth, configuredDirs);
        for (const dir of configuredDirs) {
            addChatSessionDir(results, dir);
        }
    }

    const dirs = [...results.values()];
    chatSessionDirsCache = { dirs, expiresAt: Date.now() + DEBUG_DIR_CACHE_MS };
    return dirs;
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

function requestIndexFromPath(pathParts: unknown[]): string | undefined {
    if (pathParts[0] !== 'requests' || pathParts.length < 2) {
        return undefined;
    }
    const index = pathParts[1];
    return typeof index === 'number' || typeof index === 'string' ? String(index) : undefined;
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
        value.promptTokens,
        value.inputTokens,
        metadata?.promptTokens,
        metadata?.inputTokens,
        usage?.promptTokens,
        usage?.inputTokens
    );
    const outputTokens = firstFiniteNumber(
        value.completionTokens,
        value.outputTokens,
        metadata?.completionTokens,
        metadata?.outputTokens,
        usage?.completionTokens,
        usage?.outputTokens
    );

    if (inputTokens !== undefined) {
        request.inputTokens = inputTokens;
    }
    if (outputTokens !== undefined) {
        request.outputTokens = outputTokens;
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

    const nanoAiu = parseCreditDetailsNanoAiu(value.result?.details);
    if (nanoAiu > 0) {
        request.nanoAiu = nanoAiu;
    }
    applySpendRequestModel(request, parseCreditDetailsModel(value.result?.details) ?? value.modelId ?? value.model);
    applySpendRequestTokens(request, value);
}

function updateSpendRequestFromPatch(request: SpendRequest, pathParts: unknown[], value: any): void {
    if (pathParts[2] === 'timestamp') {
        const timestamp = toFiniteNumber(value);
        if (timestamp !== undefined) {
            request.timestamp = timestamp;
        }
        return;
    }

    if (pathParts[2] === 'promptTokens' || pathParts[2] === 'inputTokens') {
        const inputTokens = toFiniteNumber(value);
        if (inputTokens !== undefined) {
            request.inputTokens = inputTokens;
        }
        return;
    }

    if (pathParts[2] === 'completionTokens' || pathParts[2] === 'outputTokens') {
        const outputTokens = toFiniteNumber(value);
        if (outputTokens !== undefined) {
            request.outputTokens = outputTokens;
        }
        return;
    }

    if (pathParts[2] === 'modelId' || pathParts[2] === 'model') {
        applySpendRequestModel(request, value);
        return;
    }

    if (pathParts[2] !== 'result') {
        return;
    }

    const details = pathParts[3] === 'details' ? value : value?.details;
    const nanoAiu = parseCreditDetailsNanoAiu(details);
    if (nanoAiu > 0) {
        request.nanoAiu = nanoAiu;
    }
    applySpendRequestModel(request, parseCreditDetailsModel(details));

    if (pathParts[3] === 'metadata') {
        if (pathParts.length === 4) {
            applySpendRequestTokens(request, { metadata: value });
        } else if (pathParts[4] === 'usage' && pathParts.length === 5) {
            applySpendRequestTokens(request, { usage: value });
        } else if (pathParts[4] === 'usage' && (pathParts[5] === 'promptTokens' || pathParts[5] === 'inputTokens')) {
            const inputTokens = toFiniteNumber(value);
            if (inputTokens !== undefined) {
                request.inputTokens = inputTokens;
            }
        } else if (pathParts[4] === 'usage' && (pathParts[5] === 'completionTokens' || pathParts[5] === 'outputTokens')) {
            const outputTokens = toFiniteNumber(value);
            if (outputTokens !== undefined) {
                request.outputTokens = outputTokens;
            }
        } else if (pathParts[4] === 'promptTokens' || pathParts[4] === 'inputTokens') {
            const inputTokens = toFiniteNumber(value);
            if (inputTokens !== undefined) {
                request.inputTokens = inputTokens;
            }
        } else if (pathParts[4] === 'completionTokens' || pathParts[4] === 'outputTokens') {
            const outputTokens = toFiniteNumber(value);
            if (outputTokens !== undefined) {
                request.outputTokens = outputTokens;
            }
        }
    } else {
        applySpendRequestTokens(request, { result: value });
    }
}

function readSpendRequestsFromChatSession(filePath: string, fallbackTimestamp: number): SpendRequest[] {
    const requests = new Map<string, SpendRequest>();
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }

    for (const line of content.split('\n')) {
        if (!line.trim() || !line.includes('requests')) {
            continue;
        }

        let raw: any;
        try {
            raw = JSON.parse(line);
        } catch {
            continue;
        }

        if (raw.kind === 0 && Array.isArray(raw.v?.requests)) {
            raw.v.requests.forEach((request: any, index: number) => {
                updateSpendRequestFromValue(requests, String(index), request);
            });
            continue;
        }

        if (!Array.isArray(raw.k) || raw.k[0] !== 'requests') {
            continue;
        }

        if (raw.kind === 2 && raw.k.length === 1 && Array.isArray(raw.v)) {
            const startIndex = toFiniteNumber(raw.i) ?? 0;
            raw.v.forEach((request: any, offset: number) => {
                updateSpendRequestFromValue(requests, String(startIndex + offset), request);
            });
            continue;
        }

        const index = requestIndexFromPath(raw.k);
        if (index === undefined) {
            continue;
        }

        if (raw.kind === 3) {
            requests.delete(index);
            continue;
        }

        if (raw.k.length === 2) {
            updateSpendRequestFromValue(requests, index, raw.v);
            continue;
        }

        updateSpendRequestFromPatch(ensureSpendRequest(requests, index), raw.k, raw.v);
    }

    return [...requests.values()]
        .filter(request => request.nanoAiu > 0)
        .map(request => ({ ...request, timestamp: request.timestamp ?? fallbackTimestamp }));
}

function createSpendBucket(label: string): SpendBucket {
    return { label, nanoAiu: 0, inputTokens: 0, outputTokens: 0, requestCount: 0, sessionCount: 0 };
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
        workspaceModels: new Map<string, SpendModelAccumulator>(),
    };
}

function addToSpendBucket(bucket: SpendBucketBase, request: SpendRequest, sessionSet: Set<string>, sessionId: string): void {
    bucket.nanoAiu += request.nanoAiu;
    bucket.inputTokens += request.inputTokens;
    bucket.outputTokens += request.outputTokens;
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
    addToSpendModelBucket(
        accumulator.modelBuckets,
        accumulator.modelSessionSets,
        request.model,
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

    let models = accumulator.workspaceModels.get(workspace.workspaceKey);
    if (!models) {
        models = createSpendModelAccumulator();
        accumulator.workspaceModels.set(workspace.workspaceKey, models);
    }
    addToSpendModels(models, request, sessionId);
}

function finalizeSpendModels(accumulator: SpendModelAccumulator): SpendModelBucket[] {
    return sortedSpendModelBuckets(accumulator.modelBuckets);
}

function finalizeSpendWorkspaces(accumulator: SpendWorkspaceAccumulator): SpendWorkspaceBucket[] {
    const workspaces = sortedSpendWorkspaceBuckets(accumulator.workspaceBuckets);
    for (const workspace of workspaces) {
        const models = accumulator.workspaceModels.get(workspace.key);
        workspace.models = models ? finalizeSpendModels(models) : [];
    }
    return workspaces;
}

type SpendScanMode = 'today' | 'full';

function computeSpendSummary(mode: SpendScanMode, refresh = false): SpendSummary {
    const cache = mode === 'full' ? fullSpendSummaryCache : todaySpendSummaryCache;
    if (!refresh && cache && cache.expiresAt > Date.now()) {
        return cache.summary;
    }

    const now = Date.now();
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
    const fileCutoff = includeHistory ? monthCutoff : todayCutoff;

    for (const chatDir of findAllChatSessionDirs(refresh)) {
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
            let stat: fs.Stats;
            try {
                stat = fs.statSync(filePath);
            } catch {
                continue;
            }
            if (stat.mtimeMs < fileCutoff) {
                continue;
            }

            summary.scannedFiles++;
            const sessionId = path.basename(entry.name, '.jsonl');
            const sessionKey = `${chatDir.workspaceKey}:${sessionId}`;
            const requests = readSpendRequestsFromChatSession(filePath, stat.mtimeMs);
            for (const request of requests) {
                const timestamp = request.timestamp ?? stat.mtimeMs;
                if (timestamp >= todayCutoff) {
                    addToSpendBucket(summary.today, request, todaySessions, sessionKey);
                    addToSpendWorkspaces(todayWorkspaces, request, sessionKey, chatDir);
                }
                if (includeHistory && summary.week && summary.month) {
                    if (timestamp >= monthCutoff) {
                        addToSpendBucket(summary.month, request, monthSessions, sessionKey);
                        addToSpendWorkspaces(monthWorkspaces, request, sessionKey, chatDir);
                    }
                    if (timestamp >= weekCutoff) {
                        addToSpendBucket(summary.week, request, weekSessions, sessionKey);
                        addToSpendWorkspaces(weekWorkspaces, request, sessionKey, chatDir);
                    }
                }
            }
        }
    }

    summary.today.workspaces = finalizeSpendWorkspaces(todayWorkspaces);
    if (includeHistory) {
        if (summary.week) {
            summary.week.workspaces = finalizeSpendWorkspaces(weekWorkspaces);
        }
        if (summary.month) {
            summary.month.workspaces = finalizeSpendWorkspaces(monthWorkspaces);
        }
    }

    const cacheEntry = { summary, expiresAt: Date.now() + SPEND_SCAN_CACHE_MS };
    if (includeHistory) {
        fullSpendSummaryCache = cacheEntry;
        todaySpendSummaryCache = {
            summary: {
                today: summary.today,
                scannedFiles: summary.scannedFiles,
                generatedAt: summary.generatedAt,
            },
            expiresAt: cacheEntry.expiresAt,
        };
    } else {
        todaySpendSummaryCache = cacheEntry;
    }
    return summary;
}

const titleCache = new Map<string, TitleEntry>();
const sessionCandidateById = new Map<string, SessionCandidate>();
let debugLogDirsCache: { expiresAt: number; dirs: string[] } | undefined;
let chatSessionDirsCache: { expiresAt: number; dirs: ChatSessionDirEntry[] } | undefined;
let todaySpendSummaryCache: { expiresAt: number; summary: SpendSummary } | undefined;
let fullSpendSummaryCache: { expiresAt: number; summary: SpendSummary } | undefined;
const workspaceLabelCache = new Map<string, string>();

function rememberSessionCandidate(candidate: SessionCandidate): void {
    const existing = sessionCandidateById.get(candidate.id);
    if (!existing || candidate.modifiedTime > existing.modifiedTime) {
        sessionCandidateById.set(candidate.id, candidate);
    }
}

function invalidateTitleCache(): void {
    titleCache.clear();
}

function readFileWindow(filePath: string, maxBytes: number, fromEnd = false): string | undefined {
    try {
        const stat = fs.statSync(filePath);
        const bytesToRead = Math.min(stat.size, maxBytes);
        const offset = fromEnd ? Math.max(0, stat.size - bytesToRead) : 0;
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
        fs.closeSync(fd);
        return buffer.toString('utf-8', 0, bytesRead);
    } catch {
        return undefined;
    }
}

function extractCustomTitle(content: string): string | undefined {
    let searchFrom = content.length;
    while (searchFrom > 0) {
        const idx = content.lastIndexOf('"customTitle"', searchFrom);
        if (idx < 0) { return undefined; }

        const lineStart = content.lastIndexOf('\n', idx) + 1;
        const lineEnd = content.indexOf('\n', idx);
        const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
        try {
            const obj = JSON.parse(line);
            if (obj.kind === 1 && typeof obj.v === 'string' && obj.v.trim()) {
                return obj.v.trim();
            }
        } catch {
            // The line may be partial if it started before the window we read.
        }
        searchFrom = idx - 1;
    }
    return undefined;
}

function readChatSessionTitle(filePath: string): string | undefined {
    const tail = readFileWindow(filePath, TITLE_CHAT_TAIL_BYTES, true);
    const fromTail = tail ? extractCustomTitle(tail) : undefined;
    if (fromTail) { return fromTail; }

    const head = readFileWindow(filePath, TITLE_DEBUG_HEAD_BYTES);
    return head ? extractCustomTitle(head) : undefined;
}

function readDebugLogTitle(filePath: string): TitleEntry | undefined {
    const chunk = readFileWindow(filePath, TITLE_DEBUG_HEAD_BYTES);
    if (!chunk) { return undefined; }

    const lines = chunk.split('\n');
    let fallback: TitleEntry | undefined;
    for (const line of lines) {
        if (!line.trim()) { continue; }
        try {
            const obj = JSON.parse(line);
            if (obj.type === 'llm_request' && obj.attrs?.debugName && !fallback) {
                const name = String(obj.attrs.debugName).trim();
                if (name && name !== 'title' && name !== 'generate title') {
                    fallback = { title: name, priority: 1 };
                }
            }
            if (obj.type === 'user_message' && obj.attrs?.content) {
                const content = String(obj.attrs.content).slice(0, 60).replace(/[\r\n]+/g, ' ').trim();
                if (content) {
                    return { title: content, priority: 2 };
                }
            }
        } catch {
            // skip partial lines
        }
    }
    return fallback;
}

function resolveSessionTitle(sessionId: string, candidate = sessionCandidateById.get(sessionId)): string | undefined {
    const cached = titleCache.get(sessionId);
    if (cached) { return cached.title; }

    let resolved: TitleEntry | undefined;
    if (candidate?.chatSessionJsonl) {
        const title = readChatSessionTitle(candidate.chatSessionJsonl);
        if (title) {
            resolved = { title, priority: 5 };
        }
    }

    if (!resolved && candidate?.mainJsonl) {
        resolved = readDebugLogTitle(candidate.mainJsonl);
    }

    if (resolved) {
        titleCache.set(sessionId, resolved);
    }

    return resolved?.title;
}

function findAllDebugLogDirs(refresh = false): string[] {
    if (!refresh && debugLogDirsCache && debugLogDirsCache.expiresAt > Date.now()) {
        return debugLogDirsCache.dirs;
    }

    const results = new Set<string>();

    for (const wsStorageRoot of getWorkspaceStorageRoots()) {
        let workspaceDirs: string[];
        try {
            workspaceDirs = fs.readdirSync(wsStorageRoot);
        } catch {
            continue;
        }

        for (const dir of workspaceDirs) {
            const debugLogsDir = path.join(wsStorageRoot, dir, 'GitHub.copilot-chat', 'debug-logs');
            if (fs.existsSync(debugLogsDir)) {
                results.add(debugLogsDir);
            }
        }
    }

    const maxDepth = vscode.workspace
        .getConfiguration('copilotUsageTracker')
        .get<number>('maxSearchDepth', 6);
    for (const root of getConfiguredSearchRoots()) {
        collectDebugLogDirs(root, maxDepth, results);
    }

    const dirs = [...results];
    debugLogDirsCache = { dirs, expiresAt: Date.now() + DEBUG_DIR_CACHE_MS };
    return dirs;
}

function scanSessionsInDir(debugLogsDir: string, options: { modifiedSince?: number } = {}): SessionScanResult {
    const sessions: SessionCandidate[] = [];
    let hasOlder = false;
    if (!fs.existsSync(debugLogsDir)) { return { sessions, hasOlder }; }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(debugLogsDir, { withFileTypes: true });
    } catch {
        return { sessions, hasOlder };
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const mainJsonl = path.join(debugLogsDir, entry.name, 'main.jsonl');
            if (fs.existsSync(mainJsonl)) {
                let debugStat: fs.Stats;
                let chatStat: fs.Stats | undefined;
                try {
                    debugStat = fs.statSync(mainJsonl);
                    const chatSessionJsonl = findSiblingChatSessionLog(mainJsonl);
                    chatStat = chatSessionJsonl ? fs.statSync(chatSessionJsonl) : undefined;
                    const modifiedTime = Math.max(debugStat.mtimeMs, chatStat?.mtimeMs || 0);
                    if (options.modifiedSince !== undefined && modifiedTime < options.modifiedSince) {
                        hasOlder = true;
                        continue;
                    }

                    const candidate: SessionCandidate = {
                        id: entry.name,
                        mainJsonl,
                        chatSessionJsonl,
                        modifiedTime,
                    };
                    rememberSessionCandidate(candidate);
                    sessions.push(candidate);
                } catch {
                    continue;
                }
            }
        }
    }
    // Sort by most recent first
    sessions.sort((a, b) => b.modifiedTime - a.modifiedTime);
    return { sessions, hasOlder };
}

function findSessionsInDir(debugLogsDir: string): SessionCandidate[] {
    return scanSessionsInDir(debugLogsDir).sessions;
}

function getWorkspaceLabelForDebugDir(debugLogsDir: string): string {
    return path.basename(path.dirname(path.dirname(debugLogsDir)));
}

function getCurrentWorkspaceDebugDir(context: vscode.ExtensionContext): string | undefined {
    if (!context.storageUri) { return undefined; }

    // storageUri is like: .../workspaceStorage/<ws-id>/copilot-usage-tracker
    // We need: .../workspaceStorage/<ws-id>/GitHub.copilot-chat/debug-logs
    const wsDir = path.dirname(context.storageUri.fsPath);
    const candidate = path.join(wsDir, 'GitHub.copilot-chat', 'debug-logs');
    return fs.existsSync(candidate) ? candidate : undefined;
}

function findSessionsForDays(daysBack?: number): SessionScanResult<SessionCandidate & { wsDir: string }> {
    const modifiedSince = daysBack === undefined
        ? undefined
        : Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const byFile = new Map<string, SessionCandidate & { wsDir: string }>();
    let hasOlder = false;

    for (const dir of findAllDebugLogDirs()) {
        const scan = scanSessionsInDir(dir, { modifiedSince });
        hasOlder = hasOlder || scan.hasOlder;
        const wsDir = getWorkspaceLabelForDebugDir(dir);
        for (const session of scan.sessions) {
            const existing = byFile.get(session.mainJsonl);
            if (!existing || session.modifiedTime > existing.modifiedTime) {
                byFile.set(session.mainJsonl, { ...session, wsDir });
            }
        }
    }

    const sessions = [...byFile.values()].sort((a, b) => b.modifiedTime - a.modifiedTime);
    return { sessions, hasOlder };
}

function safeQuickPeekHasBillingData(file: string): boolean {
    try {
        return quickPeekHasBillingData(file);
    } catch {
        return false;
    }
}

function applyResolvedTitle(summary: SessionSummary, candidate?: SessionCandidate): void {
    summary.title = resolveSessionTitle(summary.sessionId, candidate) || summary.title;
}

function parseSessionCandidate(candidate: SessionCandidate) {
    const parsed = parseCopilotSessionFile(candidate.mainJsonl);
    if (parsed) {
        applyResolvedTitle(parsed.summary, candidate);
    }
    return parsed;
}

// ---- Tree View ----

type TreeItemData =
    | { kind: 'spendSummary'; summary: SpendSummary }
    | { kind: 'spendBucket'; bucket: SpendBucket }
    | { kind: 'spendWorkspaceBucket'; bucket: SpendWorkspaceBucket }
    | { kind: 'spendWorkspaceEmpty' }
    | { kind: 'spendModelBucket'; bucket: SpendModelBucket }
    | { kind: 'spendModelEmpty' }
    | { kind: 'spendLastRefresh'; timestamp: number }
    | { kind: 'spendLoading' }
    | { kind: 'session'; summary: SessionSummary }
    | { kind: 'userMessage'; message: UserMessageSummary; index: number }
    | { kind: 'turnsGroup'; message: UserMessageSummary; msgIndex: number }
    | { kind: 'modelTurn'; turn: ModelTurnSummary; msgIndex: number; turnIndex: number }
    | { kind: 'turnToolCall'; call: ToolCallSummary }
    | { kind: 'subagentTurn'; turn: ModelTurnSummary; turnIndex: number }
    | { kind: 'mergedInfo'; message: UserMessageSummary; msgIndex: number }
    | { kind: 'mergedItem'; info: MergedMessageInfo }
    | { kind: 'toolDefinitions'; definitions: ToolDefinitionSize[]; label: string; usageCounts: Map<string, number> }
    | { kind: 'toolDef'; def: ToolDefinitionSize; usageCount: number }
    | { kind: 'commandsGroup'; commands: { name: string; count: number }[] }
    | { kind: 'commandItem'; name: string; count: number }
    | { kind: 'insights'; summary: SessionSummary }
    | { kind: 'insightGroup'; label: string; tools: { name: string; count: number }[] }
    | { kind: 'insightTool'; name: string; count: number }
    | { kind: 'stat'; label: string; value: string };

/** Count how many times each tool was called in a message (by name) */
function getToolUsageCounts(message: UserMessageSummary): Map<string, number> {
    const counts = new Map<string, number>();
    for (const turn of message.modelTurns) {
        for (const tc of turn.toolCalls) {
            counts.set(tc.name, (counts.get(tc.name) || 0) + 1);
        }
    }
    return counts;
}

/** Count tool usage across entire session */
function getSessionToolUsageCounts(summary: SessionSummary): Map<string, number> {
    const counts = new Map<string, number>();
    for (const msg of summary.userMessages) {
        for (const turn of msg.modelTurns) {
            for (const tc of turn.toolCalls) {
                counts.set(tc.name, (counts.get(tc.name) || 0) + 1);
            }
        }
    }
    return counts;
}

/** Extract terminal command names from tool calls (groups "Ran: xxx ..." by the executable) */
function getCommandGroups(message: UserMessageSummary): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const turn of message.modelTurns) {
        for (const tc of turn.toolCalls) {
            if (tc.name === 'run_in_terminal') {
                const exe = extractCommandName(tc.displayLabel);
                if (exe) {
                    counts.set(exe, (counts.get(exe) || 0) + 1);
                }
            }
        }
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
}

/** Get command groups for entire session */
function getSessionCommandGroups(summary: SessionSummary): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const msg of summary.userMessages) {
        for (const turn of msg.modelTurns) {
            for (const tc of turn.toolCalls) {
                if (tc.name === 'run_in_terminal') {
                    const exe = extractCommandName(tc.displayLabel);
                    if (exe) {
                        counts.set(exe, (counts.get(exe) || 0) + 1);
                    }
                }
            }
        }
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
}

function extractCommandName(displayLabel: string): string | undefined {
    const match = displayLabel.match(/^Ran:\s*(?:cd\s+[^;]+;\s*)?(.+)/);
    if (!match) { return undefined; }
    let cmd = match[1].trim();
    // Handle PowerShell variable assignments: $var = Command ...
    const assignMatch = cmd.match(/^\$\w+\s*=\s*(.+)/);
    if (assignMatch) {
        cmd = assignMatch[1].trim();
    }
    const exe = cmd.split(/\s+/)[0].replace(/['"]/g, '');
    // Skip remaining inline expressions that aren't real commands
    if (exe.startsWith('$') || exe.startsWith('(') || exe.startsWith('{') || exe === '') { return undefined; }
    return exe;
}

class UsageTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemData | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private summary: SessionSummary | undefined;
    private spendSummary: SpendSummary | undefined;
    private spendRefreshMode: SpendScanMode | undefined;
    private spendHistoryRequested = false;
    private requestFullSpendSummary: (() => void) | undefined;
    private debugLogsEnabled = isDebugLogsSettingEnabled();

    setSummary(summary: SessionSummary | undefined) {
        this.summary = summary;
        this._onDidChangeTreeData.fire();
    }

    setSpendSummary(summary: SpendSummary | undefined): void {
        this.spendSummary = summary;
        this.spendRefreshMode = undefined;
        this._onDidChangeTreeData.fire();
    }

    setSpendRefreshing(mode: SpendScanMode): void {
        this.spendRefreshMode = mode;
        this._onDidChangeTreeData.fire();
    }

    setFullSpendSummaryLoader(loader: () => void): void {
        this.requestFullSpendSummary = loader;
    }

    hasSpendHistoryBeenRequested(): boolean {
        return this.spendHistoryRequested;
    }

    setDebugLogsEnabled(enabled: boolean): void {
        if (this.debugLogsEnabled === enabled) {
            return;
        }

        this.debugLogsEnabled = enabled;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        switch (element.kind) {
            case 'spendSummary': {
                const s = element.summary;
                const item = new vscode.TreeItem('Spend Summary', vscode.TreeItemCollapsibleState.Collapsed);
                item.description = this.spendRefreshMode
                    ? 'refreshing...'
                    : `today ${formatAic(s.today.nanoAiu)} AIC | ${formatUsdEstimate(s.today.nanoAiu)}`;
                item.iconPath = new vscode.ThemeIcon('graph-line');
                item.tooltip = `Estimated from chat-session credit rows only.\nCollapsed view computes today's spend only. Expand to compute 7-day and 30-day spend.`;
                return item;
            }
            case 'spendBucket': {
                const b = element.bucket;
                const item = new vscode.TreeItem(
                    b.label,
                    b.workspaces ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = this.spendRefreshMode
                    ? 'refreshing...'
                    : `${formatAic(b.nanoAiu)} AIC | ${formatUsdEstimate(b.nanoAiu)} | in:${formatNumber(b.inputTokens)} out:${formatNumber(b.outputTokens)}`;
                item.iconPath = new vscode.ThemeIcon('calendar');
                item.tooltip = [
                    `${formatAic(b.nanoAiu)} AIC`,
                    formatUsdEstimate(b.nanoAiu),
                    `Input tokens: ${formatNumber(b.inputTokens)}`,
                    `Output tokens: ${formatNumber(b.outputTokens)}`,
                    `${b.requestCount} billed messages across ${b.sessionCount} sessions.`,
                ].join('\n');
                return item;
            }
            case 'spendWorkspaceBucket': {
                const b = element.bucket;
                const item = new vscode.TreeItem(
                    b.label,
                    b.models ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = `${formatAic(b.nanoAiu)} AIC | ${formatUsdEstimate(b.nanoAiu)} | ${b.requestCount} req`;
                item.iconPath = new vscode.ThemeIcon('root-folder');
                item.tooltip = [
                    `${formatAic(b.nanoAiu)} AIC`,
                    formatUsdEstimate(b.nanoAiu),
                    `Input tokens: ${formatNumber(b.inputTokens)}`,
                    `Output tokens: ${formatNumber(b.outputTokens)}`,
                    `${b.requestCount} billed requests across ${b.sessionCount} sessions.`,
                ].join('\n');
                return item;
            }
            case 'spendWorkspaceEmpty': {
                const item = new vscode.TreeItem('No billed workspaces', vscode.TreeItemCollapsibleState.None);
                item.description = 'none found';
                item.iconPath = new vscode.ThemeIcon('circle-slash');
                return item;
            }
            case 'spendModelBucket': {
                const b = element.bucket;
                const item = new vscode.TreeItem(b.label, vscode.TreeItemCollapsibleState.None);
                item.description = `${formatAic(b.nanoAiu)} AIC | ${formatUsdEstimate(b.nanoAiu)} | ${b.requestCount} req`;
                item.iconPath = new vscode.ThemeIcon('symbol-method');
                item.tooltip = [
                    `${formatAic(b.nanoAiu)} AIC`,
                    formatUsdEstimate(b.nanoAiu),
                    `Input tokens: ${formatNumber(b.inputTokens)}`,
                    `Output tokens: ${formatNumber(b.outputTokens)}`,
                    `${b.requestCount} billed requests across ${b.sessionCount} sessions.`,
                ].join('\n');
                return item;
            }
            case 'spendModelEmpty': {
                const item = new vscode.TreeItem('No billed models', vscode.TreeItemCollapsibleState.None);
                item.description = 'none found';
                item.iconPath = new vscode.ThemeIcon('circle-slash');
                return item;
            }
            case 'spendLastRefresh': {
                const item = new vscode.TreeItem('Last refreshed', vscode.TreeItemCollapsibleState.None);
                item.description = new Date(element.timestamp).toLocaleString();
                item.iconPath = new vscode.ThemeIcon('clock');
                return item;
            }
            case 'spendLoading': {
                const item = new vscode.TreeItem('Loading spend history...', vscode.TreeItemCollapsibleState.None);
                item.description = 'refreshing...';
                item.iconPath = new vscode.ThemeIcon('sync~spin');
                return item;
            }
            case 'session': {
                const s = element.summary;
                const titleDisplay = s.title || s.sessionId.slice(0, 8) + '...';
                const item = new vscode.TreeItem(
                    titleDisplay,
                    vscode.TreeItemCollapsibleState.Expanded
                );
                item.description = `${formatAic(s.totalNanoAiu)} AIC | ${formatNumber(s.totalTokens)} tokens | ${s.userMessages.length} messages`;
                item.iconPath = new vscode.ThemeIcon('graph');
                item.tooltip = [
                    `Session: ${s.sessionId}`,
                    `Total Input: ${formatNumber(s.totalInputTokens)}`,
                    `Total Output: ${formatNumber(s.totalOutputTokens)}`,
                    `Total Cached: ${formatNumber(s.totalCachedTokens)}`,
                    `Total Tokens: ${formatNumber(s.totalTokens)}`,
                    `Cost: ${formatAic(s.totalNanoAiu)} AIC`,
                    `Model Turns: ${s.modelTurnCount}`,
                    `Tool Calls: ${s.toolCallCount}`,
                    `Total LLM Time: ${formatDuration(s.totalDurationMs)}`,
                ].join('\n');
                return item;
            }
            case 'userMessage': {
                const m = element.message;
                const mergedNote = m.mergedMessages.length > 0
                    ? ` (+${m.mergedMessages.length})`
                    : '';
                const aic = parseFloat(formatAic(m.totalNanoAiu));
                const filled = aic >= 2000 ? 5 : aic >= 1400 ? 5 : aic >= 800 ? 4 : aic >= 300 ? 3 : aic >= 100 ? 2 : 1;
                const meter = aic >= 2000
                    ? '✦✦✦✦✦'
                    : '■'.repeat(filled) + '□'.repeat(5 - filled);
                // Fixed-width label: pad/truncate to 28 chars so descriptions align
                const rawPreview = (m.content || '(empty)') + mergedNote;
                const label = rawPreview.length > 28 ? rawPreview.slice(0, 27) + '…' : rawPreview.padEnd(28);
                const item = new vscode.TreeItem(
                    `${element.index + 1}: ${label}`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${formatAic(m.totalNanoAiu)} AIC  ${m.modelTurns.length} turns  ${meter}`;
                item.iconPath = new vscode.ThemeIcon('comment');
                item.tooltip = [
                    `User Message ${element.index + 1}`,
                    `"${m.content}"`,
                    m.mergedMessages.length > 0 ? `(includes ${m.mergedMessages.length} merged continuation message${m.mergedMessages.length > 1 ? 's' : ''})` : '',
                    `---`,
                    `Input Tokens: ${formatNumber(m.totalInputTokens)}`,
                    `Output Tokens: ${formatNumber(m.totalOutputTokens)}`,
                    `Cached Tokens: ${formatNumber(m.totalCachedTokens)}`,
                    `Total Tokens: ${formatNumber(m.totalTokens)}`,
                    `Cost: ${formatAic(m.totalNanoAiu)} AIC`,
                    `Model Turns: ${m.modelTurns.length}`,
                    `Tool Calls: ${m.toolCalls.length}`,
                    `LLM Time: ${formatDuration(m.totalDurationMs)}`,
                ].filter(Boolean).join('\n');
                return item;
            }
            case 'turnsGroup': {
                const m = element.message;
                const totalTools = m.modelTurns.reduce((s, t) => s + t.toolCalls.length, 0);
                const item = new vscode.TreeItem(
                    `${m.modelTurns.length} turns`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${totalTools} tool calls | ${formatDuration(m.totalDurationMs)}`;
                item.iconPath = new vscode.ThemeIcon('layers');
                return item;
            }
            case 'modelTurn': {
                const t = element.turn;
                const cacheNote = t.inputTokens > 0 ? ` | ${(t.cacheHitRatio * 100).toFixed(0)}%` : '';

                // Generate a label like Copilot Chat does: show what the turn did
                let turnLabel: string;
                let turnIcon: vscode.ThemeIcon;
                if (t.toolCalls.length === 0) {
                    turnLabel = `${element.turnIndex + 1}: Response`;
                    turnIcon = new vscode.ThemeIcon('comment-discussion');
                } else if (t.toolCalls.length === 1) {
                    const lbl = t.toolCalls[0].displayLabel.slice(0, 35);
                    turnLabel = `${element.turnIndex + 1}: ${lbl}`;
                    turnIcon = t.toolCalls[0].isSubagent ? new vscode.ThemeIcon('rocket') : new vscode.ThemeIcon('wrench');
                } else {
                    const firstLabel = t.toolCalls[0].displayLabel.slice(0, 25);
                    turnLabel = `${element.turnIndex + 1}: ${firstLabel} (+${t.toolCalls.length - 1})`;
                    turnIcon = new vscode.ThemeIcon('layers');
                }

                const item = new vscode.TreeItem(
                    turnLabel,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${formatAic(t.nanoAiu)} AIC | in:${formatNumber(t.inputTokens)} out:${formatNumber(t.outputTokens)}${cacheNote}`;
                item.iconPath = turnIcon;
                item.tooltip = [
                    `Model: ${t.model}`,
                    `Request: ${t.debugName}`,
                    `Input: ${formatNumber(t.inputTokens)}`,
                    `Output: ${formatNumber(t.outputTokens)}`,
                    `Cached: ${formatNumber(t.cachedTokens)}`,
                    `Total: ${formatNumber(t.totalTokens)}`,
                    `Cost: ${formatAic(t.nanoAiu)} AIC`,
                    `Duration: ${formatDuration(t.durationMs)}`,
                    `TTFT: ${formatDuration(t.ttftMs)}`,
                    `Tool Calls: ${t.toolCalls.length}`,
                    t.toolCalls.length > 0 ? `  ${t.toolCalls.map(tc => tc.name).join(', ')}` : '',
                ].filter(Boolean).join('\n');
                return item;
            }
            case 'turnToolCall': {
                const c = element.call;
                const hasChildren = c.isSubagent && c.subagentSummary;
                const item = new vscode.TreeItem(
                    c.displayLabel,
                    hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                const descriptionParts: string[] = [];
                if (c.durationMs > 0) {
                    descriptionParts.push(formatDuration(c.durationMs));
                }
                if (c.toolKind) {
                    descriptionParts.push(c.toolKind);
                }
                if (c.source) {
                    descriptionParts.push(c.source);
                }
                if (c.resultCount !== undefined) {
                    descriptionParts.push(`${formatNumber(c.resultCount)} result${c.resultCount === 1 ? '' : 's'}`);
                }
                item.description = descriptionParts.join(' | ');
                item.tooltip = [
                    `Tool: ${c.name}`,
                    c.toolKind ? `Kind: ${c.toolKind}` : undefined,
                    c.source ? `Source: ${c.source}` : undefined,
                    c.resultCount !== undefined ? `Results: ${formatNumber(c.resultCount)}` : undefined,
                    c.toolCallId ? `Call ID: ${c.toolCallId}` : undefined,
                    `Label: ${c.displayLabel}`,
                ].filter(Boolean).join('\n');
                if (c.isSubagent) {
                    item.iconPath = new vscode.ThemeIcon('rocket');
                    if (c.subagentSummary) {
                        const subagentDescription = `${formatAic(c.subagentSummary.totalNanoAiu)} AIC | ${c.subagentSummary.modelTurnCount} turns`;
                        item.description = item.description ? `${item.description} | ${subagentDescription}` : subagentDescription;
                    }
                } else {
                    item.iconPath = new vscode.ThemeIcon('wrench');
                }
                return item;
            }
            case 'subagentTurn': {
                const t = element.turn;
                const toolNames = t.toolCalls.map(tc => tc.displayLabel || tc.name).slice(0, 3);
                const toolPreview = toolNames.length > 0 ? toolNames.join(', ') : 'no tools';
                const item = new vscode.TreeItem(
                    `Turn ${element.turnIndex + 1}: ${t.model}`,
                    t.toolCalls.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = `${formatAic(t.nanoAiu)} AIC | ${toolPreview}`;
                item.iconPath = new vscode.ThemeIcon('symbol-method');
                return item;
            }
            case 'mergedInfo': {
                const m = element.message;
                const item = new vscode.TreeItem(
                    `Merged Continuations (${m.mergedMessages.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = 'system-triggered follow-ups';
                item.iconPath = new vscode.ThemeIcon('git-merge');
                return item;
            }
            case 'mergedItem': {
                const info = element.info;
                const item = new vscode.TreeItem(info.content, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('arrow-right');
                item.tooltip = `SpanId: ${info.spanId}\nTimestamp: ${new Date(info.timestamp).toLocaleTimeString()}`;
                return item;
            }
            case 'toolDefinitions': {
                const defs = element.definitions;
                const totalUsed = [...element.usageCounts.values()].reduce((s, c) => s + c, 0);
                const uniqueUsed = element.usageCounts.size;
                const item = new vscode.TreeItem(
                    `Tools (${defs.length} available, ${uniqueUsed} used, ${totalUsed} calls)`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = element.label;
                item.iconPath = new vscode.ThemeIcon('symbol-method');
                return item;
            }
            case 'toolDef': {
                const d = element.def;
                const count = element.usageCount;
                const item = new vscode.TreeItem(d.name, vscode.TreeItemCollapsibleState.None);
                if (count > 0) {
                    item.description = `×${count} | ~${formatNumber(d.estimatedTokens)} tokens`;
                    item.iconPath = new vscode.ThemeIcon('check');
                } else {
                    item.description = `unused | ~${formatNumber(d.estimatedTokens)} tokens`;
                    item.iconPath = new vscode.ThemeIcon('circle-slash');
                }
                return item;
            }
            case 'commandsGroup': {
                const total = element.commands.reduce((s, c) => s + c.count, 0);
                const item = new vscode.TreeItem(
                    `Commands (${element.commands.length} executables, ${total} runs)`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.iconPath = new vscode.ThemeIcon('terminal');
                return item;
            }
            case 'commandItem': {
                const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
                item.description = `×${element.count}`;
                item.iconPath = new vscode.ThemeIcon('terminal-bash');
                return item;
            }
            case 'insights': {
                const item = new vscode.TreeItem(
                    'Insights',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.iconPath = new vscode.ThemeIcon('lightbulb');
                item.description = 'tool usage analysis & command summary';
                return item;
            }
            case 'insightGroup': {
                const item = new vscode.TreeItem(
                    element.label,
                    element.tools.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = `${element.tools.length} tools`;
                item.iconPath = new vscode.ThemeIcon('tag');
                return item;
            }
            case 'insightTool': {
                const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
                item.description = element.count > 0 ? `×${element.count}` : 'never used';
                item.iconPath = element.count === 0
                    ? new vscode.ThemeIcon('circle-slash')
                    : new vscode.ThemeIcon('wrench');
                return item;
            }
            case 'stat': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.description = element.value;
                item.iconPath = new vscode.ThemeIcon('info');
                if (element.label === 'Total Cost') {
                    item.description = `${element.value} [Learn more]`;
                    item.command = {
                        command: 'vscode.open',
                        title: 'Learn more',
                        arguments: [AI_CREDITS_DOCS_URI],
                    };
                    item.tooltip = `${element.value}\nOpen GitHub docs for AI Credits.`;
                } else if (element.label === 'Estimated USD') {
                    item.iconPath = new vscode.ThemeIcon('credit-card');
                    item.tooltip = 'Estimated from GitHub AI credits at 1 AIC = $0.01 USD.';
                } else if (element.label === 'Enable Debug Logs') {
                    item.iconPath = new vscode.ThemeIcon('settings-gear');
                    item.command = {
                        command: 'workbench.action.openSettings',
                        title: 'Open setting',
                        arguments: [DEBUG_LOGS_SETTING],
                    };
                    item.tooltip = `Open ${DEBUG_LOGS_SETTING} and set it to true for exact per-turn AIC, cache, TTFT, and prompt/tool-definition details.`;
                }
                return item;
            }
        }
    }

    getChildren(element?: TreeItemData): TreeItemData[] {
        if (!element) {
            const roots: TreeItemData[] = [];
            if (this.spendSummary) {
                roots.push({ kind: 'spendSummary', summary: this.spendSummary });
            }
            if (this.summary) {
                roots.push({ kind: 'session', summary: this.summary });
            }
            return roots;
        }

        if (element.kind === 'spendSummary') {
            this.spendHistoryRequested = true;
            if (!element.summary.week || !element.summary.month) {
                if (this.spendRefreshMode !== 'full') {
                    this.requestFullSpendSummary?.();
                }
                return [{ kind: 'spendLoading' }];
            }

            return [
                { kind: 'spendBucket', bucket: element.summary.today },
                { kind: 'spendBucket', bucket: element.summary.week },
                { kind: 'spendBucket', bucket: element.summary.month },
                { kind: 'spendLastRefresh', timestamp: element.summary.generatedAt },
            ];
        }

        if (element.kind === 'spendBucket') {
            const workspaces = element.bucket.workspaces;
            if (!workspaces) {
                return [];
            }
            return workspaces.length > 0
                ? workspaces.map(bucket => ({
                    kind: 'spendWorkspaceBucket' as const,
                    bucket,
                }))
                : [{ kind: 'spendWorkspaceEmpty' as const }];
        }

        if (element.kind === 'spendWorkspaceBucket') {
            const models = element.bucket.models;
            if (!models) {
                return [];
            }
            return models.length > 0
                ? models.map(bucket => ({
                    kind: 'spendModelBucket' as const,
                    bucket,
                }))
                : [{ kind: 'spendModelEmpty' as const }];
        }

        if (!this.summary) {
            return [];
        }

        switch (element.kind) {
            case 'session': {
                const s = element.summary;
                const stats: TreeItemData[] = [
                    { kind: 'stat', label: 'Total Cost', value: `${formatAic(s.totalNanoAiu)} AIC` },
                    { kind: 'stat', label: 'Estimated USD', value: formatUsdEstimate(s.totalNanoAiu) },
                    ...(s.sourceType !== 'debugLog' && !this.debugLogsEnabled
                        ? [{ kind: 'stat' as const, label: 'Enable Debug Logs', value: 'for richer per-turn data' }]
                        : []),
                    { kind: 'stat', label: 'Total Tokens', value: `${formatNumber(s.totalTokens)} (in:${formatNumber(s.totalInputTokens)} out:${formatNumber(s.totalOutputTokens)} cache:${formatNumber(s.totalCachedTokens)})` },
                    { kind: 'stat', label: 'Total LLM Time', value: formatDuration(s.totalDurationMs) },
                    { kind: 'stat', label: 'Model Turns / Tool Calls', value: `${s.modelTurnCount} / ${s.toolCallCount}` },
                ];
                stats.push({ kind: 'stat', label: '💡 Tip', value: 'Type @usage in Copilot Chat to ask AI about this session' });
                // Insights node (lazy-computed on expand)
                stats.push({ kind: 'insights', summary: s });
                const messages: TreeItemData[] = s.userMessages.map((m, i) => ({
                    kind: 'userMessage' as const,
                    message: m,
                    index: i,
                }));
                return [...stats, ...messages];
            }
            case 'userMessage': {
                const m = element.message;
                const children: TreeItemData[] = [];
                // Summary stats
                children.push({ kind: 'stat', label: 'Cost', value: `${formatAic(m.totalNanoAiu)} AIC` });
                children.push({ kind: 'stat', label: 'Tokens', value: `in:${formatNumber(m.totalInputTokens)} out:${formatNumber(m.totalOutputTokens)} cache:${formatNumber(m.totalCachedTokens)}` });
                children.push({ kind: 'stat', label: 'Context at Start', value: `~${formatNumber(estimateTokens(m.contextCharsAtStart))} tokens (${formatNumber(m.contextCharsAtStart)} chars)` });
                if (m.systemPromptFile) {
                    const sp = this.summary?.promptComposition?.systemPrompts[m.systemPromptFile];
                    const spInfo = sp ? ` (~${formatNumber(sp.estimatedTokens)} tokens)` : '';
                    children.push({ kind: 'stat', label: 'System Prompt', value: `${m.systemPromptFile}${spInfo}` });
                }
                // Tool definitions with usage counts for this message
                if (m.toolsFile && this.summary?.promptComposition?.toolSets[m.toolsFile]) {
                    const defs = this.summary.promptComposition.toolSets[m.toolsFile];
                    const usageCounts = getToolUsageCounts(m);
                    children.push({ kind: 'toolDefinitions', definitions: defs, label: m.toolsFile, usageCounts });
                }
                // Commands group
                const commands = getCommandGroups(m);
                if (commands.length > 0) {
                    children.push({ kind: 'commandsGroup', commands });
                }
                // Turns group
                children.push({ kind: 'turnsGroup', message: m, msgIndex: element.index });
                // Merged continuations info
                if (m.mergedMessages.length > 0) {
                    children.push({ kind: 'mergedInfo', message: m, msgIndex: element.index });
                }
                return children;
            }
            case 'turnsGroup': {
                const m = element.message;
                return m.modelTurns.map((turn, i) => ({
                    kind: 'modelTurn' as const,
                    turn,
                    msgIndex: element.msgIndex,
                    turnIndex: i,
                }));
            }
            case 'modelTurn': {
                const t = element.turn;
                const cachePercent = (t.cacheHitRatio * 100).toFixed(0);
                const children: TreeItemData[] = [
                    { kind: 'stat', label: 'Cost', value: `${formatAic(t.nanoAiu)} AIC` },
                    { kind: 'stat', label: 'Tokens', value: `in:${formatNumber(t.inputTokens)} out:${formatNumber(t.outputTokens)} cache:${formatNumber(t.cachedTokens)}` },
                    { kind: 'stat', label: 'Cache', value: `${cachePercent}% hit (${formatNumber(t.freshTokens)} fresh tokens)` },
                    { kind: 'stat', label: 'Duration / TTFT', value: `${formatDuration(t.durationMs)} / ${formatDuration(t.ttftMs)}` },
                ];
                // Tool calls for this turn
                for (const tc of t.toolCalls) {
                    children.push({ kind: 'turnToolCall', call: tc });
                }
                return children;
            }
            case 'turnToolCall': {
                // Expand subagent summary if available
                const c = element.call;
                if (c.subagentSummary) {
                    const s = c.subagentSummary;
                    const children: TreeItemData[] = [
                        { kind: 'stat', label: 'Subagent Cost', value: `${formatAic(s.totalNanoAiu)} AIC` },
                        { kind: 'stat', label: 'Subagent Tokens', value: `in:${formatNumber(s.totalInputTokens)} out:${formatNumber(s.totalOutputTokens)}` },
                    ];
                    // Show subagent turns
                    for (const msg of s.userMessages) {
                        for (let i = 0; i < msg.modelTurns.length; i++) {
                            children.push({ kind: 'subagentTurn', turn: msg.modelTurns[i], turnIndex: i });
                        }
                    }
                    return children;
                }
                return [];
            }
            case 'subagentTurn': {
                const t = element.turn;
                const children: TreeItemData[] = [
                    { kind: 'stat', label: 'Tokens', value: `in:${formatNumber(t.inputTokens)} out:${formatNumber(t.outputTokens)} cache:${formatNumber(t.cachedTokens)}` },
                ];
                for (const tc of t.toolCalls) {
                    children.push({ kind: 'turnToolCall', call: tc });
                }
                return children;
            }
            case 'mergedInfo': {
                return element.message.mergedMessages.map(info => ({
                    kind: 'mergedItem' as const,
                    info,
                }));
            }
            case 'toolDefinitions': {
                // Sort: used tools first (by count desc), then unused
                const sorted = [...element.definitions].sort((a, b) => {
                    const ca = element.usageCounts.get(a.name) || 0;
                    const cb = element.usageCounts.get(b.name) || 0;
                    return cb - ca;
                });
                return sorted.map(def => ({
                    kind: 'toolDef' as const,
                    def,
                    usageCount: element.usageCounts.get(def.name) || 0,
                }));
            }
            case 'commandsGroup': {
                return element.commands.map(cmd => ({
                    kind: 'commandItem' as const,
                    name: cmd.name,
                    count: cmd.count,
                }));
            }
            case 'insights': {
                const s = element.summary;
                const sessionUsage = getSessionToolUsageCounts(s);

                // Get all observed tool names, plus available debug-log tool definitions when present.
                const allToolNames = new Set<string>();
                if (s.promptComposition) {
                    for (const defs of Object.values(s.promptComposition.toolSets)) {
                        for (const d of defs) { allToolNames.add(d.name); }
                    }
                }
                for (const name of sessionUsage.keys()) {
                    allToolNames.add(name);
                }

                // Categorize tools by usage
                const unused: { name: string; count: number }[] = [];
                const low: { name: string; count: number }[] = [];     // 1-2
                const medium: { name: string; count: number }[] = [];  // 3-5
                const high: { name: string; count: number }[] = [];    // 5+

                for (const name of allToolNames) {
                    const count = sessionUsage.get(name) || 0;
                    if (count === 0) { unused.push({ name, count }); }
                    else if (count <= 2) { low.push({ name, count }); }
                    else if (count <= 5) { medium.push({ name, count }); }
                    else { high.push({ name, count }); }
                }

                // Sort each group
                low.sort((a, b) => b.count - a.count);
                medium.sort((a, b) => b.count - a.count);
                high.sort((a, b) => b.count - a.count);
                unused.sort((a, b) => a.name.localeCompare(b.name));

                const children: TreeItemData[] = [
                    { kind: 'insightGroup', label: `Heavy (5+ calls)`, tools: high },
                    { kind: 'insightGroup', label: `Medium (3-5 calls)`, tools: medium },
                    { kind: 'insightGroup', label: `Light (1-2 calls)`, tools: low },
                    { kind: 'insightGroup', label: `Never Used (wasted tokens)`, tools: unused },
                ];

                // Session-wide command groups
                const sessionCommands = getSessionCommandGroups(s);
                if (sessionCommands.length > 0) {
                    children.push({ kind: 'commandsGroup', commands: sessionCommands });
                }

                return children;
            }
            case 'insightGroup': {
                return element.tools.map(t => ({
                    kind: 'insightTool' as const,
                    name: t.name,
                    count: t.count,
                }));
            }
            default:
                return [];
        }
    }
}

type SessionPickItem =
    | (vscode.QuickPickItem & { itemType: 'session'; session: SessionCandidate & { wsDir: string } })
    | (vscode.QuickPickItem & { itemType: 'loadMore' });

function getCurrentWorkspaceLatestSessionId(context: vscode.ExtensionContext): string | undefined {
    const currentWsDebugDir = getCurrentWorkspaceDebugDir(context);
    if (!currentWsDebugDir) { return undefined; }

    const sessions = scanSessionsInDir(currentWsDebugDir).sessions;
    return sessions[0]?.id;
}

function createSessionPickItems(
    sessions: (SessionCandidate & { wsDir: string })[],
    currentWsSessionId: string | undefined,
    hasOlder: boolean,
    loadedDays: number
): SessionPickItem[] {
    const items: SessionPickItem[] = sessions.map(session => {
        const title = resolveSessionTitle(session.id, session);
        const date = new Date(session.modifiedTime);
        const timeStr = date.toLocaleString();
        const isCurrent = session.id === currentWsSessionId;
        const currentTag = isCurrent ? ' (current session)' : '';
        return {
            itemType: 'session',
            label: `${title || session.id.slice(0, 8) + '...'}${currentTag}`,
            description: `${timeStr}${title ? ' (' + session.id.slice(0, 8) + ')' : ''}`,
            detail: session.mainJsonl,
            session,
        };
    });

    if (hasOlder) {
        items.push({
            itemType: 'loadMore',
            label: '$(history) Load older sessions',
            description: `Currently showing last ${loadedDays} days`,
            detail: `Adds ${PICK_LOAD_MORE_DAYS} more days to this list.`,
            alwaysShow: true,
        });
    }

    return items;
}

export function activate(context: vscode.ExtensionContext) {
    const treeProvider = new UsageTreeProvider();
    treeProvider.setDebugLogsEnabled(isDebugLogsSettingEnabled());

    vscode.window.createTreeView('copilotUsageTree', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(DEBUG_LOGS_SETTING)) {
            treeProvider.setDebugLogsEnabled(isDebugLogsSettingEnabled());
        }
    }));

    // File watcher state
    let currentSessionFile: string | undefined;
    let currentSessionCandidate: SessionCandidate | undefined;
    let fileWatcher: vscode.FileSystemWatcher | undefined;
    let debounceTimer: NodeJS.Timeout | undefined;
    let spendRefreshTimer: NodeJS.Timeout | undefined;

    const scheduleSpendSummaryRefresh = (mode: SpendScanMode, refresh = false, delayMs = 250) => {
        if (spendRefreshTimer) {
            clearTimeout(spendRefreshTimer);
        }

        treeProvider.setSpendRefreshing(mode);
        spendRefreshTimer = setTimeout(() => {
            spendRefreshTimer = undefined;
            try {
                treeProvider.setSpendSummary(computeSpendSummary(mode, refresh));
            } catch (err) {
                console.warn('Copilot Usage: failed to compute spend summary', err);
            }
        }, delayMs);
    };
    const scheduleVisibleSpendSummaryRefresh = (refresh = false, delayMs = 250) => {
        scheduleSpendSummaryRefresh(treeProvider.hasSpendHistoryBeenRequested() ? 'full' : 'today', refresh, delayMs);
    };
    treeProvider.setFullSpendSummaryLoader(() => {
        scheduleSpendSummaryRefresh('full', false, 0);
    });
    const spendAutoRefreshInterval = setInterval(() => {
        scheduleVisibleSpendSummaryRefresh(true);
    }, SPEND_AUTO_REFRESH_MS);
    context.subscriptions.push(new vscode.Disposable(() => {
        if (spendRefreshTimer) {
            clearTimeout(spendRefreshTimer);
        }
        clearInterval(spendAutoRefreshInterval);
    }));

    // Auto-load the most recent session, prioritizing the current workspace
    const autoLoad = () => {
        const currentWsDebugDir = getCurrentWorkspaceDebugDir(context);

        // Collect all sessions, prioritizing current workspace
        let allSessions: SessionCandidate[] = [];

        if (currentWsDebugDir) {
            // Try current workspace first
            allSessions = findSessionsInDir(currentWsDebugDir);
        }

        if (allSessions.length === 0) {
            // Fall back to all workspaces, sorted by most recent globally
            allSessions = findSessionsForDays(INITIAL_PICK_DAYS).sessions;
            if (allSessions.length === 0) {
                allSessions = findSessionsForDays().sessions;
            }
        }

        const billingCandidates = allSessions.slice(0, 10);
        const picked = billingCandidates.find(s => safeQuickPeekHasBillingData(s.mainJsonl)) ?? allSessions[0];
        if (picked) {
            const parsed = parseSessionCandidate(picked);
            if (parsed) {
                treeProvider.setSummary(parsed.summary);
                setCurrentGraph(parsed.summary);
                vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', true);
                currentSessionCandidate = picked;
                currentSessionFile = parsed.sourceFile;
                return;
            }
        }
        // Only show "no logs" welcome after confirmed search found nothing
        vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', false);
    };

    function watchCurrentSession() {
        // Dispose previous watcher
        if (fileWatcher) {
            fileWatcher.dispose();
            fileWatcher = undefined;
        }
        if (!currentSessionFile) { return; }

        const dir = path.dirname(currentSessionFile);
        const filename = path.basename(currentSessionFile);
        const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), filename);
        fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        fileWatcher.onDidChange(() => {
            // Debounce: wait 500ms after last change before re-parsing
            if (debounceTimer) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                if (currentSessionFile) {
                    const parsed = parseCopilotSessionFile(currentSessionFile);
                    if (parsed) {
                        applyResolvedTitle(parsed.summary, currentSessionCandidate);
                        treeProvider.setSummary(parsed.summary);
                        setCurrentGraph(parsed.summary);
                        scheduleSpendSummaryRefresh('today', true, 1000);
                    }
                }
            }, 500);
        });

        context.subscriptions.push(fileWatcher);
    }

    autoLoad();
    watchCurrentSession();
    scheduleVisibleSpendSummaryRefresh();

    // Register chat participant (@usage)
    registerChatParticipant(context, (daysBack?: number) => {
        return findSessionsForDays(daysBack).sessions;
    }, resolveSessionTitle);

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotUsageTracker.analyzeSession', () => {
            autoLoad();
            watchCurrentSession();
            scheduleVisibleSpendSummaryRefresh(true);
            vscode.window.showInformationMessage('Copilot Usage: Loaded most recent session.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotUsageTracker.refresh', () => {
            autoLoad();
            watchCurrentSession();
            scheduleVisibleSpendSummaryRefresh(true);
        })
    );

    let isPickingSession = false;
    const setPickingSession = async (value: boolean) => {
        isPickingSession = value;
        await vscode.commands.executeCommand('setContext', 'copilotUsageTracker.isPickingSession', value);
    };
    void setPickingSession(false);

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotUsageTracker.pickSession.loading', () => undefined),
        vscode.commands.registerCommand('copilotUsageTracker.pickSession', async () => {
            if (isPickingSession) {
                vscode.window.showInformationMessage('Copilot Usage: already loading sessions.');
                return;
            }

            await setPickingSession(true);
            invalidateTitleCache();

            const quickPick = vscode.window.createQuickPick<SessionPickItem>();
            const disposables: vscode.Disposable[] = [];
            let loadedDays = INITIAL_PICK_DAYS;
            let disposed = false;

            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;
            quickPick.ignoreFocusOut = true;
            quickPick.title = 'Pick Copilot Chat Session';
            quickPick.placeholder = `Loading sessions from the last ${loadedDays} days...`;
            quickPick.busy = true;
            quickPick.enabled = false;

            const refreshItems = async () => {
                quickPick.busy = true;
                quickPick.enabled = false;
                quickPick.placeholder = `Loading sessions from the last ${loadedDays} days...`;

                // Let VS Code paint the busy state before synchronous filesystem work starts.
                await new Promise(resolve => setTimeout(resolve, 0));

                const { sessions, hasOlder } = findSessionsForDays(loadedDays);
                const currentWsSessionId = getCurrentWorkspaceLatestSessionId(context);
                quickPick.items = createSessionPickItems(sessions, currentWsSessionId, hasOlder, loadedDays);
                quickPick.placeholder = sessions.length > 0
                    ? `Select a chat session from the last ${loadedDays} days`
                    : `No sessions found in the last ${loadedDays} days`;
                quickPick.enabled = true;
                quickPick.busy = false;
            };

            const finish = async () => {
                if (disposed) { return; }
                disposed = true;
                for (const disposable of disposables) {
                    disposable.dispose();
                }
                quickPick.dispose();
                await setPickingSession(false);
            };

            disposables.push(
                quickPick.onDidHide(() => {
                    void finish();
                }),
                quickPick.onDidAccept(async () => {
                    const picked = quickPick.selectedItems[0];
                    if (!picked) { return; }

                    if (picked.itemType === 'loadMore') {
                        loadedDays += PICK_LOAD_MORE_DAYS;
                        await refreshItems();
                        return;
                    }

                    quickPick.busy = true;
                    quickPick.enabled = false;
                    quickPick.placeholder = 'Loading selected session...';

                    await new Promise(resolve => setTimeout(resolve, 0));
                    const parsed = parseSessionCandidate(picked.session);
                    if (parsed) {
                        treeProvider.setSummary(parsed.summary);
                        setCurrentGraph(parsed.summary);
                        vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', true);
                        currentSessionCandidate = picked.session;
                        currentSessionFile = parsed.sourceFile;
                        watchCurrentSession();
                        scheduleVisibleSpendSummaryRefresh(true);
                        const titleDisplay = parsed.summary.title || parsed.summary.sessionId.slice(0, 8) + '...';
                        vscode.window.showInformationMessage(
                            `Loaded "${titleDisplay}" | ${formatAic(parsed.summary.totalNanoAiu)} AIC | ${formatNumber(parsed.summary.totalTokens)} tokens`
                        );
                        quickPick.hide();
                    } else {
                        quickPick.enabled = true;
                        quickPick.busy = false;
                        vscode.window.showErrorMessage('Failed to parse the debug log file.');
                    }
                })
            );

            quickPick.show();
            await refreshItems();
        })
    );
}

export function deactivate() {}
