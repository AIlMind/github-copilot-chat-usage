import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { WorkspaceIndex, readWorkspaceIdentity, readEventWorkspace, workspacePathLabel } from './workspaces';
import { discoverUsageDirectories, DiscoveryOptions, UsageDirectories } from './discovery';
import { backgroundDependencies, backgroundHasUsage } from './background';
import { backgroundModifiedTime, configureIdentityCache, prepareBackgroundIndex, resolveBackgroundFiles, withoutFullBackgroundIndex } from './backgroundIdentity';
import { filePathKey } from './sqliteSnapshot';
import { findSiblingChatSessionLog, SessionSummary, parseCopilotSessionFile, setBackgroundCliRoots } from './parser';
import { ChatSessionDirEntry, SpendSummary, UsageFile, computeSpendSummaryFromChatSessionDirs } from './spend';

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

const INITIAL_PICK_DAYS = 3;
const DEBUG_DIR_CACHE_MS = 30_000;
const SPEND_AUTO_REFRESH_MS = 5 * 60 * 1000;
const SPEND_SCAN_CACHE_MS = SPEND_AUTO_REFRESH_MS;
const TITLE_CHAT_TAIL_BYTES = 256 * 1024;
const TITLE_DEBUG_HEAD_BYTES = 16 * 1024;

export interface SessionCandidate {
    title?: string;
    id: string;
    mainJsonl: string;
    chatSessionJsonl?: string;
    modifiedTime: number;
}

export interface SessionScanResult<T extends SessionCandidate = SessionCandidate> {
    sessions: T[];
    hasOlder: boolean;
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
            ...readWorkspaceIdentity(workspaceStorageDir),
        };
    }

    return {
        dir: resolvedDir,
        workspaceKey: resolvedDir,
        workspaceLabel: workspacePathLabel(path.dirname(resolvedDir)),
    };
}

let discoveryOptions: DiscoveryOptions = {};
let usageDirsCache: { expiresAt: number; dirs: UsageDirectories } | undefined;

function usageDirectories(refresh = false): UsageDirectories {
    if (!refresh && usageDirsCache && usageDirsCache.expiresAt > Date.now()) { return usageDirsCache.dirs; }
    const dirs = discoverUsageDirectories(discoveryOptions);
    setBackgroundCliRoots(dirs.cli, dirs.agent, dirs.debug);
    usageDirsCache = { dirs, expiresAt: Date.now() + DEBUG_DIR_CACHE_MS };
    return dirs;
}

function findAllChatSessionDirs(refresh = false): ChatSessionDirEntry[] {
    return usageDirectories(refresh).chat.map(chatSessionDirEntry);
}

function findUsageFiles(refresh = false, modifiedSince = 0): UsageFile[] {
    const dirs = usageDirectories(refresh);
    prepareBackgroundIndex(dirs.agent, true, modifiedSince);
    return withoutFullBackgroundIndex(() => {
        const workspaces = new WorkspaceIndex([...dirs.chat.filter(d => path.basename(d) === 'chatSessions').map(path.dirname), ...dirs.debug.map(d => path.dirname(path.dirname(d))).filter(d => path.basename(d) !== 'globalStorage')]);
        const files: UsageFile[] = [];
        const seen = new Set<string>();
        const add = (root: string, filename: string, kind: UsageFile['kind']) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (!entry.isDirectory()) { continue; }
                const dir = path.join(root, entry.name);
                const file = path.join(dir, filename);
                if (!fs.existsSync(file)) { continue; }
                if (kind === 'background' && modifiedSince && backgroundModifiedTime(file) < modifiedSince) { continue; }
                const resolved = kind === 'background' ? resolveBackgroundFiles(file, dirs.cli, dirs.agent) : undefined;
                const workspace = kind === 'debug'
                    ? chatSessionDirEntry(path.join(path.dirname(path.dirname(root)), path.basename(path.dirname(path.dirname(root))) === 'globalStorage' ? 'emptyWindowChatSessions' : 'chatSessions'))
                    : workspaces.resolve(resolved?.workspace ?? readEventWorkspace(resolved?.eventsFile), resolved?.workspaces, resolved?.workspaceless);
                const canonicalFile = resolved?.dbFile ?? file;
                if (seen.has(filePathKey(canonicalFile))) { continue; }
                seen.add(filePathKey(canonicalFile));
                files.push({ ...workspace, dir: path.dirname(canonicalFile), file: canonicalFile, sessionId: resolved?.sessionId ?? entry.name, kind });
            }
        };
        dirs.debug.forEach(root => add(root, 'main.jsonl', 'debug'));
        dirs.cli.forEach(root => add(root, 'events.jsonl', 'background'));
        dirs.agent.forEach(root => add(root, 'session.db', 'background'));
        return files;
    });
}

type SpendScanMode = 'today' | 'full';

function computeSpendSummary(mode: SpendScanMode, refresh = false, cacheFilePath?: string): SpendSummary {
    const cache = mode === 'full' ? fullSpendSummaryCache : todaySpendSummaryCache;
    if (!refresh && cache && cache.expiresAt > Date.now()) {
        return cache.summary;
    }

    const chatDirs = findAllChatSessionDirs(refresh);
    const usageFiles = findUsageFiles(false, mode === 'today' ? new Date().setHours(0, 0, 0, 0) : 0);
    // Discovery prepared either the recent or full identity map. Parsing must not
    // silently turn a recent scan into a full database scan through reverse lookup.
    const summary = withoutFullBackgroundIndex(() => computeSpendSummaryFromChatSessionDirs(mode, chatDirs, { cacheFilePath, usageFiles, cliRoots: usageDirectories().cli, agentRoots: usageDirectories().agent }));

    if (cacheFilePath) {
        const file = cacheFilePath + '.summary-v12', temp = file + '.' + randomUUID() + '.tmp';
        try { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(temp, JSON.stringify(summary), {mode:0o600}); fs.renameSync(temp,file); }
        catch { /* Optional first-paint cache. */ }
        finally { try { fs.rmSync(temp,{force:true}); } catch {} }
    }
    const cacheEntry = { summary, expiresAt: Date.now() + SPEND_SCAN_CACHE_MS };
    if (mode === 'full') {
        fullSpendSummaryCache = cacheEntry;
        todaySpendSummaryCache = {
            summary: {
                today: summary.today,
                notes: summary.notes,
                undatedRequests: summary.undatedRequests,
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
let todaySpendSummaryCache: { expiresAt: number; summary: SpendSummary } | undefined;
let fullSpendSummaryCache: { expiresAt: number; summary: SpendSummary } | undefined;

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
            if (obj.kind === 0 && typeof obj.v?.customTitle === 'string' && obj.v.customTitle.trim()) {
                return obj.v.customTitle.trim();
            }
        } catch {
            const title = extractJsonStringProperty(content, 'customTitle', idx);
            if (title) {
                return title;
            }
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

function extractJsonStringProperty(content: string, propertyName: string, startIndex: number): string | undefined {
    const afterIndex = content.slice(startIndex);
    const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = afterIndex.match(new RegExp(`"${escapedName}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
    if (!match) {
        return undefined;
    }

    try {
        const value = JSON.parse(match[1]);
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    } catch {
        return undefined;
    }
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
        if (['session.db', 'events.jsonl'].includes(path.basename(candidate.mainJsonl))) {
            const files = resolveBackgroundFiles(candidate.mainJsonl, usageDirectories().cli, usageDirectories().agent);
            if (files.title) { resolved = { title: files.title, priority: 5 }; }
            else if (files.eventsFile) {
                // Bounded title peek; never parse a whole multi-hundred-MB log for a picker label.
                for (const line of readFileWindow(files.eventsFile, 2 * 1024 * 1024).split('\n')) {
                    try {
                        const e = JSON.parse(line);
                        if (e.type === 'user.message' && !e.agentId && !e.data?.parentToolCallId && typeof e.data?.content === 'string' && e.data.content.trim()) {
                            resolved = { title: e.data.content.replace(/\s+/g, ' ').trim().slice(0, 100), priority: 2 }; break;
                        }
                    } catch { /* Truncated title prefix. */ }
                }
            }
        } else { resolved = readDebugLogTitle(candidate.mainJsonl); }
    }

    if (resolved) {
        titleCache.set(sessionId, resolved);
    }

    return resolved?.title;
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

function findSessionsForDays(daysBack?: number): SessionScanResult<SessionCandidate & { wsDir: string }> {
    const modifiedSince = daysBack === undefined
        ? undefined
        : Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const byFile = new Map<string, SessionCandidate & { wsDir: string }>();
    let hasOlder = false;

    const byId = new Map<string, SessionCandidate & { wsDir: string }>();
    const add = (candidate: SessionCandidate, wsDir: string) => {
        if (modifiedSince !== undefined && candidate.modifiedTime < modifiedSince) { hasOlder = true; return; }
        const existing = byId.get(candidate.id);
        // A debug trajectory preserves per-model-call detail. Use persisted background/transcript
        // data when that trajectory is absent, rather than showing duplicate picker entries.
        if (!existing || (path.basename(candidate.mainJsonl) === 'main.jsonl' && path.basename(existing.mainJsonl) !== 'main.jsonl') ||
            (path.basename(candidate.mainJsonl) === path.basename(existing.mainJsonl) && candidate.modifiedTime > existing.modifiedTime)) {
            byId.set(candidate.id, { ...candidate, wsDir });
            rememberSessionCandidate(candidate);
        }
    };
    for (const source of findUsageFiles()) {
        try {
            if (source.kind === 'background' && !backgroundHasUsage(source.file, usageDirectories().cli, usageDirectories().agent)) { continue; }
            const deps = source.kind === 'background' ? backgroundDependencies(source.file, usageDirectories().cli, usageDirectories().agent) :
                fs.readdirSync(source.dir).filter(n => n.endsWith('.jsonl')).map(n => path.join(source.dir, n));
            const modifiedTime = Math.max(...deps.map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }));
            add({ id: source.sessionId, mainJsonl: source.file, modifiedTime, chatSessionJsonl: source.kind === 'debug' ? findSiblingChatSessionLog(source.file) : undefined }, source.workspaceLabel);
        } catch { /* Store may disappear during a scan. */ }
    }
    for (const chatDir of findAllChatSessionDirs()) {
        let files: string[];
        try { files = fs.readdirSync(chatDir.dir); } catch { continue; }
        for (const name of files) {
            if (!name.endsWith('.jsonl')) { continue; }
            const id = path.basename(name, '.jsonl');
            if (byId.has(id)) { continue; }
            const file = path.join(chatDir.dir, name);
            try { add({ id, mainJsonl: file, chatSessionJsonl: file, modifiedTime: fs.statSync(file).mtimeMs }, chatDir.workspaceLabel); } catch { /* Removed concurrently. */ }
        }
    }
    for (const candidate of byId.values()) { byFile.set(candidate.mainJsonl, candidate); sessionCandidateById.set(candidate.id, candidate); }

    const sessions = [...byFile.values()].sort((a, b) => b.modifiedTime - a.modifiedTime);
    for (const session of sessions) { session.title = resolveSessionTitle(session.id, session); }
    return { sessions, hasOlder };
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


function currentWorkspaceSessions(): SessionCandidate[] {
    const ws = discoveryOptions.storagePath && path.dirname(discoveryOptions.storagePath);
    const dir = ws && usageDirectories().debug.find(dir => path.dirname(path.dirname(dir)) === ws);
    return dir ? findSessionsInDir(dir) : [];
}

export function configure(options: DiscoveryOptions): void {
    discoveryOptions = options;
    configureIdentityCache(options.globalStoragePath);
    usageDirsCache = undefined;
    todaySpendSummaryCache = fullSpendSummaryCache = undefined;
    titleCache.clear();
    sessionCandidateById.clear();
}

export const scanner = {
    configure,
    directories: (refresh = false) => usageDirectories(refresh),
    list: (days?: number) => {
        invalidateTitleCache();
        const result = findSessionsForDays(days);
        return { ...result, currentId: currentWorkspaceSessions()[0]?.id };
    },
    parse: (candidate: SessionCandidate) => {
        usageDirectories();
        titleCache.delete(candidate.id);
        return parseSessionCandidate(candidate);
    },
    dependencies: (file: string) => ['session.db', 'events.jsonl'].includes(path.basename(file))
        ? withoutFullBackgroundIndex(() => [...new Set(backgroundDependencies(file, usageDirectories().cli, usageDirectories().agent).map(path.dirname))])
        : [path.dirname(file)],
    cachedSpend: (file?: string): SpendSummary | undefined => {
        if (!file) { return; }
        try {
            const s = JSON.parse(fs.readFileSync(file + '.summary-v12','utf8'));
            if (s.today && typeof s.today.nanoAiu === 'number' && new Date(s.generatedAt).toDateString() === new Date().toDateString()) {
                return { today: s.today, generatedAt: s.generatedAt, scannedFiles: s.scannedFiles, notes: s.notes };
            }
        } catch { /* No compatible saved totals. */ }
        return undefined;
    },
    spend: computeSpendSummary,
    indexHistory: () => { prepareBackgroundIndex(usageDirectories().agent, false); },
    autoLoad: () => {
        let sessions = currentWorkspaceSessions();
        if (!sessions.length) {
            const dirs = usageDirectories();
            const recent: SessionCandidate[] = [];
            for (const [roots, name] of [[dirs.cli,'events.jsonl'],[dirs.agent,'session.db']] as const) {
                for (const root of roots) {
                    let names: string[]; try { names = fs.readdirSync(root); } catch { continue; }
                    for (const id of names) {
                        const file = path.join(root,id,name);
                        try { const modifiedTime = Math.max(fs.statSync(file).mtimeMs, ...['-wal'].map(s => { try { return fs.statSync(file+s).mtimeMs; } catch { return 0; } })); recent.push({id,mainJsonl:file,modifiedTime}); } catch {}
                    }
                }
            }
            const result = withoutFullBackgroundIndex(() => {
                for (const candidate of recent.sort((a,b)=>b.modifiedTime-a.modifiedTime).slice(0,10)) {
                    try { const parsed = parseSessionCandidate(candidate); if (parsed && (parsed.summary.totalNanoAiu > 0 || parsed.summary.totalTokens > 0)) { return {candidate,parsed}; } } catch {}
                }
                return undefined;
            });
            if (result) { return result; }
            sessions = findSessionsForDays(INITIAL_PICK_DAYS).sessions;
        }
        if (!sessions.length) { sessions = findSessionsForDays().sessions; }
        // Parse a candidate only once. Previously the billing peek parsed background logs
        // in full, then the selected session was parsed again.
        let fallback: { candidate: SessionCandidate; parsed: ReturnType<typeof parseSessionCandidate> } | undefined;
        for (let i = 0; i < sessions.length; i++) {
            try {
                const candidate = sessions[i];
                const parsed = parseSessionCandidate(candidate);
                if (!parsed) { continue; }
                const result = { candidate, parsed };
                if (parsed.summary.totalNanoAiu > 0 || parsed.summary.totalTokens > 0) { return result; }
                fallback ??= result;
                if (i >= 9 && fallback) { return fallback; }
            } catch { /* Another store can still supply the current session. */ }
        }
        return fallback;
    },
};
export type Scanner = typeof scanner;
