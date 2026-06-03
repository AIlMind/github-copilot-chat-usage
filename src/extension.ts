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
                            // Read entire file and search for customTitle line
                            // (customTitle can be far into the file for long sessions)
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
                            // Read first 4KB to find first user_message or debugName
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
    const exe = cmd.split(/\s+/)[0].replace(/['"]/g, '');
    // Skip remaining inline expressions that aren't real commands
    if (exe.startsWith('$') || exe.startsWith('(') || exe.startsWith('{') || exe === '') { return undefined; }
    return exe;
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
                }
                return item;
            }
        }
    }

    getChildren(element?: TreeItemData): TreeItemData[] {
        if (!this.summary) {
            return [];
        }

        if (!element) {
            return [{ kind: 'session', summary: this.summary }];
        }

        switch (element.kind) {
            case 'session': {
                const s = element.summary;
                const stats: TreeItemData[] = [
                    { kind: 'stat', label: 'Total Cost', value: `${formatAic(s.totalNanoAiu)} AIC` },
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

export function activate(context: vscode.ExtensionContext) {
    const treeProvider = new UsageTreeProvider();

    vscode.window.createTreeView('copilotUsageTree', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });

    // Auto-load the most recent session, prioritizing the current workspace
    const autoLoad = () => {
        const debugLogDirs = findAllDebugLogDirs();

        // Determine current workspace's debug-log dir from storageUri
        let currentWsDebugDir: string | undefined;
        if (context.storageUri) {
            // storageUri is like: .../workspaceStorage/<ws-id>/copilot-usage-tracker
            // We need: .../workspaceStorage/<ws-id>/GitHub.copilot-chat/debug-logs
            const wsDir = path.dirname(context.storageUri.fsPath);
            const candidate = path.join(wsDir, 'GitHub.copilot-chat', 'debug-logs');
            if (fs.existsSync(candidate)) {
                currentWsDebugDir = candidate;
            }
        }

        // Collect all sessions, prioritizing current workspace
        let allSessions: SessionCandidate[] = [];

        if (currentWsDebugDir) {
            // Try current workspace first
            allSessions = findSessionsInDir(currentWsDebugDir);
        }

        if (allSessions.length === 0) {
            // Fall back to all workspaces, sorted by most recent globally
            for (const dir of debugLogDirs) {
                allSessions.push(...findSessionsInDir(dir));
            }
            allSessions.sort((a, b) => b.modifiedTime - a.modifiedTime);
        }

        const picked = allSessions.find(s => safeQuickPeekHasBillingData(s.mainJsonl)) ?? allSessions[0];
        if (picked) {
            const parsed = parseSessionCandidate(picked);
            if (parsed) {
                applyResolvedTitle(parsed.summary);
                treeProvider.setSummary(parsed.summary);
                setCurrentGraph(parsed.summary);
                vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', true);
                currentSessionFile = parsed.sourceFile;
                return;
            }
        }
        // Only show "no logs" welcome after confirmed search found nothing
        vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', false);
    };

    // File watcher state
    let currentSessionFile: string | undefined;
    let fileWatcher: vscode.FileSystemWatcher | undefined;
    let debounceTimer: NodeJS.Timeout | undefined;

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
                vscode.window.showWarningMessage('No Copilot debug log sessions found. Enable "github.copilot.chat.agentDebugLog.fileLogging.enabled".');
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
