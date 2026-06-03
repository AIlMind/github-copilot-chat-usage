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
    parseCopilotSessionFile,
    readEntriesIncremental,
    quickPeekHasBillingData,
    formatNumber,
    formatAic,
    formatDuration,
    estimateTokens,
} from './parser';
import { setCurrentGraph, registerChatParticipant } from './participant';

// Keeps this helper referenced when parser.ts exports it but this file only needs it indirectly.
void readEntriesIncremental;

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

function pathExists(candidate: string | undefined): candidate is string {
    return !!candidate && fs.existsSync(candidate);
}

function pushUnique(items: string[], value: string | undefined): void {
    if (!value || items.includes(value)) { return; }
    items.push(value);
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

function buildTitleCache(): Map<string, TitleEntry> {
    const cache = new Map<string, TitleEntry>();
    for (const wsStorageRoot of getWorkspaceStorageRoots()) {
        let workspaceDirs: string[];
        try {
            workspaceDirs = fs.readdirSync(wsStorageRoot);
        } catch {
            continue;
        }

        for (const dir of workspaceDirs) {
            // Priority 5: customTitle from chatSessions JSONL
            const chatSessionsDir = path.join(wsStorageRoot, dir, 'chatSessions');
            if (fs.existsSync(chatSessionsDir)) {
                try {
                    const files = fs.readdirSync(chatSessionsDir);
                    for (const file of files) {
                        if (!file.endsWith('.jsonl')) { continue; }
                        const sessionId = file.replace('.jsonl', '');
                        if (cache.has(sessionId) && cache.get(sessionId)!.priority >= 5) { continue; }

                        const filePath = path.join(chatSessionsDir, file);
                        try {
                            // Read entire file and search for customTitle line.
                            const content = fs.readFileSync(filePath, 'utf-8');
                            const lastIdx = content.lastIndexOf('"customTitle"');
                            if (lastIdx >= 0) {
                                const lineStart = content.lastIndexOf('\n', lastIdx) + 1;
                                const lineEnd = content.indexOf('\n', lastIdx);
                                const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
                                try {
                                    const obj = JSON.parse(line);
                                    if (obj.kind === 1 && obj.v) {
                                        cache.set(sessionId, { title: obj.v, priority: 5 });
                                    }
                                } catch { /* partial line */ }
                            }
                        } catch { /* skip */ }
                    }
                } catch { /* skip */ }
            }

            // Priority 2: First user message content from debug logs
            const debugLogsDir = path.join(wsStorageRoot, dir, 'GitHub.copilot-chat', 'debug-logs');
            if (fs.existsSync(debugLogsDir)) {
                try {
                    const sessions = fs.readdirSync(debugLogsDir, { withFileTypes: true });
                    for (const entry of sessions) {
                        if (!entry.isDirectory()) { continue; }
                        const sessionId = entry.name;
                        if (cache.has(sessionId) && cache.get(sessionId)!.priority >= 2) { continue; }

                        const mainJsonl = path.join(debugLogsDir, sessionId, 'main.jsonl');
                        if (!fs.existsSync(mainJsonl)) { continue; }

                        try {
                            // Read first 4KB to find first user_message or debugName.
                            const fd = fs.openSync(mainJsonl, 'r');
                            const buf = Buffer.alloc(4096);
                            const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
                            fs.closeSync(fd);

                            const chunk = buf.toString('utf-8', 0, bytesRead);
                            const lines = chunk.split('\n');
                            for (const line of lines) {
                                if (!line.trim()) { continue; }
                                try {
                                    const obj = JSON.parse(line);
                                    // Priority 1: debugName
                                    if (obj.type === 'llm_request' && obj.attrs?.debugName &&
                                        !cache.has(sessionId)) {
                                        const name = obj.attrs.debugName;
                                        if (name !== 'title' && name !== 'generate title') {
                                            cache.set(sessionId, { title: name, priority: 1 });
                                        }
                                    }

                                    // Priority 2: first user message
                                    if (obj.type === 'user_message' && obj.attrs?.content) {
                                        const content = obj.attrs.content.slice(0, 60).replace(/[\r\n]+/g, ' ').trim();
                                        if (content && (!cache.has(sessionId) || cache.get(sessionId)!.priority < 2)) {
                                            cache.set(sessionId, { title: content, priority: 2 });
                                            break; // first user message found
                                        }
                                    }
                                } catch { /* partial line */ }
                            }
                        } catch { /* skip */ }
                    }
                } catch { /* skip */ }
            }
        }
    }

    return cache;
}

/** Lazily-built title cache, rebuilt when pickSession is called */
let titleCache: Map<string, TitleEntry> | undefined;

function getTitleCache(): Map<string, TitleEntry> {
    if (!titleCache) {
        titleCache = buildTitleCache();
    }
    return titleCache;
}

function invalidateTitleCache(): void {
    titleCache = undefined;
}

function resolveSessionTitle(sessionId: string): string | undefined {
    const entry = getTitleCache().get(sessionId);
    return entry?.title;
}

function findDebugLogDir(): string | undefined {
    return findAllDebugLogDirs()[0];
}

function findAllDebugLogDirs(): string[] {
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

    return [...results];
}

interface SessionCandidate {
    id: string;
    mainJsonl: string;
    chatSessionJsonl?: string;
    modifiedTime: number;
}

function findSessionsInDir(debugLogsDir: string): SessionCandidate[] {
    const sessions: SessionCandidate[] = [];
    if (!fs.existsSync(debugLogsDir)) { return sessions; }

    const entries = fs.readdirSync(debugLogsDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const mainJsonl = path.join(debugLogsDir, entry.name, 'main.jsonl');
            if (fs.existsSync(mainJsonl)) {
                const debugStat = fs.statSync(mainJsonl);
                const chatSessionJsonl = findSiblingChatSessionLog(mainJsonl);
                const chatStat = chatSessionJsonl ? fs.statSync(chatSessionJsonl) : undefined;
                sessions.push({
                    id: entry.name,
                    mainJsonl,
                    chatSessionJsonl,
                    modifiedTime: Math.max(debugStat.mtimeMs, chatStat?.mtimeMs || 0),
                });
            }
        }
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.modifiedTime - a.modifiedTime);
    return sessions;
}

// ---- Tree View ----

type TreeItemData =
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

    const exe = cmd.split(/\s+/)[0].replace(/["']/g, '');
    // Skip remaining inline expressions that aren't real commands
    if (exe.startsWith('$') || exe.startsWith('(') || exe.startsWith('{') || exe === '') { return undefined; }
    return exe;
}

function asAny<T = any>(value: unknown): T {
    return value as T;
}

function getToolDefinitions(source: unknown): ToolDefinitionSize[] {
    const raw = asAny(source).toolDefinitions ?? asAny(source).toolDefinitionSizes ?? [];
    return Array.isArray(raw) ? raw as ToolDefinitionSize[] : [];
}

function getToolDefinitionName(def: ToolDefinitionSize): string {
    const d = asAny(def);
    return String(d.name ?? d.toolName ?? d.label ?? d.id ?? '(tool)');
}

function getToolDefinitionTokenCount(def: ToolDefinitionSize): number {
    const d = asAny(def);
    const direct = d.tokens ?? d.tokenCount ?? d.estimatedTokens ?? d.estimateTokens ?? d.inputTokens ?? d.sizeTokens;
    if (typeof direct === 'number') { return direct; }

    const text = d.schema ?? d.definition ?? d.description ?? d.raw ?? JSON.stringify(d);
    return estimateTokens(String(text ?? ''));
}

function getMergedMessageText(info: MergedMessageInfo): string {
    const i = asAny(info);
    return String(i.content ?? i.message ?? i.text ?? i.prompt ?? '(merged message)');
}

function compactLabel(text: string, maxLength: number): string {
    const normalized = text.replace(/[\r\n]+/g, ' ').trim();
    return normalized.length > maxLength ? normalized.slice(0, maxLength - 1) + '…' : normalized;
}

class UsageTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemData | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private summary: SessionSummary | undefined;

    setSummary(summary: SessionSummary | undefined) {
        this.summary = summary;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        switch (element.kind) {
            case 'session': {
                const s = element.summary;
                const titleDisplay = s.title || s.sessionId.slice(0, 8) + '...';
                const item = new vscode.TreeItem(
                    titleDisplay,
                    vscode.TreeItemCollapsibleState.Expanded
                );
                item.description = `${formatAic(s.totalNanoAiu)} AIC | ${formatNumber(s.totalTokens)} tokens | ${s.modelTurnCount} turns`;
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
                    : '■'.repeat(filled) + '▫'.repeat(5 - filled);

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
                    `${m.content}`,
                    m.mergedMessages.length > 0 ? `(includes ${m.mergedMessages.length} merged continuation messages${m.mergedMessages.length > 1 ? 's' : ''})` : '',
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
                item.description = `${totalTools} tc | ${formatDuration(m.totalDurationMs)}`;
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
                    t.toolCalls.length > 0 ? ` ${t.toolCalls.map(tc => tc.name).join(', ')}` : '',
                ].filter(Boolean).join('\n');
                return item;
            }

            case 'turnToolCall': {
                const c = element.call;
                const hasChildren = Boolean(c.isSubagent && c.subagentSummary);
                const item = new vscode.TreeItem(
                    c.displayLabel,
                    hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = formatDuration(c.durationMs);
                if (c.isSubagent) {
                    item.iconPath = new vscode.ThemeIcon('rocket');
                    if (c.subagentSummary) {
                        item.description += ` | ${formatAic(c.subagentSummary.totalNanoAiu)} AIC | ${c.subagentSummary.modelTurnCount} turns`;
                    }
                } else {
                    item.iconPath = new vscode.ThemeIcon('wrench');
                }
                item.tooltip = [
                    `Tool: ${c.name}`,
                    `Label: ${c.displayLabel}`,
                    `Duration: ${formatDuration(c.durationMs)}`,
                    c.isSubagent ? 'Subagent: yes' : '',
                    c.subagentSummary ? `Subagent Cost: ${formatAic(c.subagentSummary.totalNanoAiu)} AIC` : '',
                    c.subagentSummary ? `Subagent Turns: ${c.subagentSummary.modelTurnCount}` : '',
                ].filter(Boolean).join('\n');
                return item;
            }

            case 'subagentTurn': {
                const t = element.turn;
                const firstTool = t.toolCalls[0]?.displayLabel;
                const item = new vscode.TreeItem(
                    `${element.turnIndex + 1}: ${firstTool ? compactLabel(firstTool, 35) : 'Subagent response'}`,
                    t.toolCalls.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = `${formatAic(t.nanoAiu)} AIC | ${t.toolCalls.length} tc | ${formatDuration(t.durationMs)}`;
                item.iconPath = new vscode.ThemeIcon('rocket');
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
                ].join('\n');
                return item;
            }

            case 'mergedInfo': {
                const count = element.message.mergedMessages.length;
                const item = new vscode.TreeItem(
                    `Merged continuation messages (${count})`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = 'included in this request';
                item.iconPath = new vscode.ThemeIcon('git-merge');
                return item;
            }

            case 'mergedItem': {
                const text = getMergedMessageText(element.info);
                const item = new vscode.TreeItem(
                    compactLabel(text || '(empty)', 60),
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = `${formatNumber(estimateTokens(text))} est. tokens`;
                item.iconPath = new vscode.ThemeIcon('comment');
                item.tooltip = text;
                return item;
            }

            case 'toolDefinitions': {
                const totalTokens = element.definitions.reduce((sum, def) => sum + getToolDefinitionTokenCount(def), 0);
                const item = new vscode.TreeItem(
                    element.label,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${element.definitions.length} tools | ~${formatNumber(totalTokens)} tokens`;
                item.iconPath = new vscode.ThemeIcon('symbol-method');
                return item;
            }

            case 'toolDef': {
                const name = getToolDefinitionName(element.def);
                const tokens = getToolDefinitionTokenCount(element.def);
                const item = new vscode.TreeItem(
                    name,
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = `~${formatNumber(tokens)} tokens | used ${element.usageCount}`;
                item.iconPath = new vscode.ThemeIcon(element.usageCount > 0 ? 'tools' : 'circle-outline');
                item.tooltip = JSON.stringify(element.def, undefined, 2);
                return item;
            }

            case 'commandsGroup': {
                const total = element.commands.reduce((sum, cmd) => sum + cmd.count, 0);
                const item = new vscode.TreeItem(
                    'Terminal commands',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${total} runs | ${element.commands.length} commands`;
                item.iconPath = new vscode.ThemeIcon('terminal');
                return item;
            }

            case 'commandItem': {
                const item = new vscode.TreeItem(
                    element.name,
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = `${element.count} run${element.count === 1 ? '' : 's'}`;
                item.iconPath = new vscode.ThemeIcon('terminal');
                return item;
            }

            case 'insights': {
                const item = new vscode.TreeItem(
                    'Insights',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${formatAic(element.summary.totalNanoAiu)} AIC | ${formatNumber(element.summary.totalTokens)} tokens`;
                item.iconPath = new vscode.ThemeIcon('lightbulb');
                return item;
            }

            case 'insightGroup': {
                const total = element.tools.reduce((sum, t) => sum + t.count, 0);
                const item = new vscode.TreeItem(
                    element.label,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${total} calls`;
                item.iconPath = new vscode.ThemeIcon('list-tree');
                return item;
            }

            case 'insightTool': {
                const item = new vscode.TreeItem(
                    element.name,
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = `${element.count}`;
                item.iconPath = new vscode.ThemeIcon('symbol-method');
                return item;
            }

            case 'stat': {
                const item = new vscode.TreeItem(
                    element.label,
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = element.value;
                item.iconPath = new vscode.ThemeIcon('pulse');
                return item;
            }
        }
    }

    getChildren(element?: TreeItemData): vscode.ProviderResult<TreeItemData[]> {
        if (!element) {
            return this.summary ? [{ kind: 'session', summary: this.summary }] : [];
        }

        switch (element.kind) {
            case 'session': {
                const s = element.summary;
                const children: TreeItemData[] = [
                    { kind: 'insights', summary: s },
                    ...s.userMessages.map((message, index) => ({ kind: 'userMessage' as const, message, index })),
                ];

                const definitions = getToolDefinitions(s);
                if (definitions.length > 0) {
                    children.push({
                        kind: 'toolDefinitions',
                        definitions,
                        label: 'Tool definitions',
                        usageCounts: getSessionToolUsageCounts(s),
                    });
                }

                const commands = getSessionCommandGroups(s);
                if (commands.length > 0) {
                    children.push({ kind: 'commandsGroup', commands });
                }

                return children;
            }

            case 'userMessage': {
                const m = element.message;
                const children: TreeItemData[] = [];

                if (m.mergedMessages.length > 0) {
                    children.push({ kind: 'mergedInfo', message: m, msgIndex: element.index });
                }

                if (m.modelTurns.length > 0) {
                    children.push({ kind: 'turnsGroup', message: m, msgIndex: element.index });
                }

                const definitions = getToolDefinitions(m);
                if (definitions.length > 0) {
                    children.push({
                        kind: 'toolDefinitions',
                        definitions,
                        label: 'Tool definitions in prompt',
                        usageCounts: getToolUsageCounts(m),
                    });
                }

                const commands = getCommandGroups(m);
                if (commands.length > 0) {
                    children.push({ kind: 'commandsGroup', commands });
                }

                return children;
            }

            case 'turnsGroup': {
                return element.message.modelTurns.map((turn, turnIndex) => ({
                    kind: 'modelTurn' as const,
                    turn,
                    msgIndex: element.msgIndex,
                    turnIndex,
                }));
            }

            case 'modelTurn': {
                return element.turn.toolCalls.map(call => ({ kind: 'turnToolCall' as const, call }));
            }

            case 'turnToolCall': {
                const summary = element.call.subagentSummary;
                if (!summary) { return []; }

                const turns: ModelTurnSummary[] = [];
                for (const msg of summary.userMessages) {
                    turns.push(...msg.modelTurns);
                }

                return turns.map((turn, turnIndex) => ({ kind: 'subagentTurn' as const, turn, turnIndex }));
            }

            case 'subagentTurn': {
                return element.turn.toolCalls.map(call => ({ kind: 'turnToolCall' as const, call }));
            }

            case 'mergedInfo': {
                return element.message.mergedMessages.map(info => ({ kind: 'mergedItem' as const, info }));
            }

            case 'toolDefinitions': {
                return [...element.definitions]
                    .sort((a, b) => getToolDefinitionTokenCount(b) - getToolDefinitionTokenCount(a))
                    .map(def => ({
                        kind: 'toolDef' as const,
                        def,
                        usageCount: element.usageCounts.get(getToolDefinitionName(def)) || 0,
                    }));
            }

            case 'commandsGroup': {
                return element.commands.map(command => ({
                    kind: 'commandItem' as const,
                    name: command.name,
                    count: command.count,
                }));
            }

            case 'insights': {
                const s = element.summary;
                const toolCounts = [...getSessionToolUsageCounts(s).entries()]
                    .map(([name, count]) => ({ name, count }))
                    .sort((a, b) => b.count - a.count);
                const commandCounts = getSessionCommandGroups(s);

                const children: TreeItemData[] = [
                    { kind: 'stat', label: 'Total cost', value: `${formatAic(s.totalNanoAiu)} AIC` },
                    { kind: 'stat', label: 'Total tokens', value: formatNumber(s.totalTokens) },
                    { kind: 'stat', label: 'Input tokens', value: formatNumber(s.totalInputTokens) },
                    { kind: 'stat', label: 'Output tokens', value: formatNumber(s.totalOutputTokens) },
                    { kind: 'stat', label: 'Cached tokens', value: formatNumber(s.totalCachedTokens) },
                    { kind: 'stat', label: 'User messages', value: formatNumber(s.userMessages.length) },
                    { kind: 'stat', label: 'Model turns', value: formatNumber(s.modelTurnCount) },
                    { kind: 'stat', label: 'Tool calls', value: formatNumber(s.toolCallCount) },
                    { kind: 'stat', label: 'Total LLM time', value: formatDuration(s.totalDurationMs) },
                ];

                if (toolCounts.length > 0) {
                    children.push({ kind: 'insightGroup', label: 'Top tools', tools: toolCounts.slice(0, 20) });
                }

                if (commandCounts.length > 0) {
                    children.push({ kind: 'insightGroup', label: 'Terminal commands', tools: commandCounts.slice(0, 20) });
                }

                return children;
            }

            case 'insightGroup': {
                return element.tools.map(tool => ({ kind: 'insightTool' as const, name: tool.name, count: tool.count }));
            }

            case 'mergedItem':
            case 'toolDef':
            case 'commandItem':
            case 'insightTool':
            case 'stat':
                return [];
        }
    }
}

const treeProvider = new UsageTreeProvider();
const TREE_VIEW_ID = 'copilotUsageTracker';

function registerUsageTreeProvider(context: vscode.ExtensionContext) {
    const packageJson = asAny(context).extension?.packageJSON;
    const ids = new Set<string>();
    const contributedViews = packageJson?.contributes?.views;

    if (contributedViews && typeof contributedViews === 'object') {
        for (const views of Object.values(contributedViews)) {
            if (!Array.isArray(views)) { continue; }
            for (const view of views) {
                const id = asAny(view).id;
                if (typeof id === 'string' && /copilot|usage/i.test(id)) {
                    ids.add(id);
                }
            }
        }
    }

    if (ids.size === 0) {
        ids.add(TREE_VIEW_ID);
    }

    for (const id of ids) {
        context.subscriptions.push(vscode.window.registerTreeDataProvider(id, treeProvider));
    }
}

function safeQuickPeekHasBillingData(file: string): boolean {
    try {
        return quickPeekHasBillingData(file);
    } catch {
        return false;
    }
}

function applyResolvedTitle(summary: SessionSummary): void {
    summary.title = resolveSessionTitle(summary.sessionId) || summary.title;
}

function parseSessionCandidate(candidate: SessionCandidate) {
    return parseCopilotSessionFile(candidate.mainJsonl);
}

export function activate(context: vscode.ExtensionContext) {
    registerUsageTreeProvider(context);

    // File watcher state
    let currentSessionFile: string | undefined;
    let fileWatcher: vscode.FileSystemWatcher | undefined;
    let debounceTimer: NodeJS.Timeout | undefined;

    function autoLoad() {
        const firstDebugLogDir = findDebugLogDir();
        const debugLogDirs = findAllDebugLogDirs();
        if (firstDebugLogDir && !debugLogDirs.includes(firstDebugLogDir)) {
            debugLogDirs.unshift(firstDebugLogDir);
        }

        const allSessions: SessionCandidate[] = [];
        for (const dir of debugLogDirs) {
            allSessions.push(...findSessionsInDir(dir));
        }
        allSessions.sort((a, b) => b.modifiedTime - a.modifiedTime);

        const picked = allSessions.find(s => safeQuickPeekHasBillingData(s.mainJsonl)) ?? allSessions[0];
        if (!picked) {
            treeProvider.setSummary(undefined);
            vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', false);
            return;
        }

        const parsed = parseSessionCandidate(picked);
        if (parsed) {
            applyResolvedTitle(parsed.summary);
            treeProvider.setSummary(parsed.summary);
            setCurrentGraph(parsed.summary);
            vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', true);
            currentSessionFile = parsed.sourceFile;
        }
    }

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
                        applyResolvedTitle(parsed.summary);
                        treeProvider.setSummary(parsed.summary);
                        setCurrentGraph(parsed.summary);
                    }
                }
            }, 500);
        });

        context.subscriptions.push(fileWatcher);
    }

    autoLoad();
    watchCurrentSession();

    // Register chat participant (@usage)
    registerChatParticipant(context, () => {
        const dirs = findAllDebugLogDirs();
        const all: SessionCandidate[] = [];
        for (const dir of dirs) { all.push(...findSessionsInDir(dir)); }
        all.sort((a, b) => b.modifiedTime - a.modifiedTime);
        return all;
    }, resolveSessionTitle);

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotUsageTracker.analyzeSession', () => {
            autoLoad();
            watchCurrentSession();
            vscode.window.showInformationMessage('Copilot Usage: Loaded most recent session.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotUsageTracker.refresh', () => {
            autoLoad();
            watchCurrentSession();
        })
    );

    async function notifyNoDebugLogsFound() {
        const action = 'Open Settings';
        const message = 'No Copilot debug log sessions found. To enable logging, open settings and enable "github.copilot.chat.agentDebugLog.fileLogging.enabled", then open the Copilot Chat debug view and run a chat.';
        const selection = await vscode.window.showWarningMessage(message, action);
        if (selection === action) {
            vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot.chat.agentDebugLog.fileLogging.enabled');
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotUsageTracker.pickSession', async () => {
            // Invalidate cache so we get fresh titles
            invalidateTitleCache();
            const titles = getTitleCache();

            const debugLogDirs = findAllDebugLogDirs();
            const allSessions: (SessionCandidate & { wsDir: string })[] = [];

            for (const dir of debugLogDirs) {
                const sessions = findSessionsInDir(dir);
                for (const s of sessions) {
                    allSessions.push({ ...s, wsDir: path.basename(path.dirname(path.dirname(dir))) });
                }
            }

            // Sort all sessions by most recent
            allSessions.sort((a, b) => b.modifiedTime - a.modifiedTime);

            if (allSessions.length === 0) {
                await notifyNoDebugLogsFound();
                return;
            }

            // Determine current workspace's most recent session
            let currentWsSessionId: string | undefined;
            if (context.storageUri) {
                const wsDir = path.dirname(context.storageUri.fsPath);
                const candidate = path.join(wsDir, 'GitHub.copilot-chat', 'debug-logs');
                if (fs.existsSync(candidate)) {
                    const wsSessions = findSessionsInDir(candidate);
                    if (wsSessions.length > 0) {
                        currentWsSessionId = wsSessions[0].id;
                    }
                }
            }

            // Filter: show sessions that have a title (real chat sessions)
            // PLUS any recent untitled sessions (likely active/current sessions that haven't been titled yet)
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;
            const recentCutoff = Date.now() - ONE_DAY_MS;
            const sessionsToShow = allSessions.filter(s =>
                titles.has(s.id) || s.modifiedTime > recentCutoff
            );

            // Fallback: if nothing matches, show all
            const finalList = sessionsToShow.length > 0 ? sessionsToShow : allSessions;

            const items = finalList.slice(0, 30).map(s => {
                const date = new Date(s.modifiedTime);
                const timeStr = date.toLocaleString();
                const titleEntry = titles.get(s.id);
                const title = titleEntry?.title;
                const isCurrent = s.id === currentWsSessionId;
                const currentTag = isCurrent ? ' (current session)' : '';
                return {
                    label: `${title || s.id.slice(0, 8) + '...'}${currentTag}`,
                    description: `${timeStr}${title ? ' (' + s.id.slice(0, 8) + ')' : ''}`,
                    detail: s.mainJsonl,
                    session: s,
                };
            });

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a chat session to analyze',
            });

            if (picked) {
                const parsed = parseSessionCandidate(picked.session);
                if (parsed) {
                    applyResolvedTitle(parsed.summary);
                    treeProvider.setSummary(parsed.summary);
                    setCurrentGraph(parsed.summary);
                    vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', true);
                    currentSessionFile = parsed.sourceFile;
                    watchCurrentSession();
                    const titleDisplay = parsed.summary.title || parsed.summary.sessionId.slice(0, 8) + '...';
                    vscode.window.showInformationMessage(
                        `Loaded "${titleDisplay}" | ${formatAic(parsed.summary.totalNanoAiu)} AIC | ${formatNumber(parsed.summary.totalTokens)} tokens`
                    );
                } else {
                    vscode.window.showErrorMessage('Failed to parse the debug log file.');
                }
            }
        })
    );

}

export function deactivate() {}
