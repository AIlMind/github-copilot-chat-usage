import * as vscode from 'vscode';
import * as path from 'path';
import { canonicalModelId, modelLabel, modelSequence, modelCostMix, sessionModelTurns } from './modelNames';
import { UsageClient } from './usageClient';
import { RefreshScheduler } from './refreshScheduler';
import type { AgentDetails, RoutingDecision, PermissionCheck } from './backgroundDiagnostics';
import type { SessionCandidate } from './scanner';
import { ToolCallSummary, ModelTurnSummary, MergedMessageInfo, UserMessageSummary, SessionSummary,
    ToolDefinitionSize, NANO_AIU_PER_AIC, formatNumber, formatRecordedTokens, formatAic, formatDuration, estimateTokens } from './parser';
import { setCurrentGraph, registerChatParticipant } from './participant';
import { SpendBucket, SpendModelBucket, SpendSummary, SpendWorkspaceBucket, SpendScanMode, getSpendFileCachePath } from './spend';
const AI_CREDITS_DOCS_URI = vscode.Uri.parse('https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals');
const DEBUG_LOGS_SETTING = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';
const INITIAL_PICK_DAYS = 3;
const PICK_LOAD_MORE_DAYS = 10;
const AUTO_REFRESH_MS = 30_000;
const DISCOVERY_REFRESH_MS = 5 * 60 * 1000;
function formatTokenCost(nanoAiu: number): string {
    return (nanoAiu / NANO_AIU_PER_AIC).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 9 });
}

function formatUsdEstimate(nanoAiu: number): string {
    if (nanoAiu <= 0) {
        return '$0.00 USD est.';
    }

    const aic = nanoAiu / NANO_AIU_PER_AIC;
    const usd = aic / 100;
    return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)} USD est.`;
}


function formatLocalDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString(vscode.env.language || undefined);
}


function formatLocalTime(timestamp: number): string {
    if (!timestamp) { return 'Time not saved'; }
    return new Date(timestamp).toLocaleTimeString(vscode.env.language || undefined);
}


function isDebugLogsSettingEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(DEBUG_LOGS_SETTING) === true;
}


// ---- Tree View ----

type TreeItemData =
    | { kind: 'agentGroup'; role: 'main' | 'agent' | 'saved'; agent?: AgentDetails; turns: ModelTurnSummary[]; msgIndex: number }
    | { kind: 'routingGroup'; routing: RoutingDecision[]; signals?: string[] }
    | { kind: 'routingDecision'; route: RoutingDecision }
    | { kind: 'modelSelections'; summary: SessionSummary }
    | { kind: 'permissionGroup'; checks: PermissionCheck[] }
    | { kind: 'spendSummary'; summary: SpendSummary }
    | { kind: 'spendBucket'; bucket: SpendBucket }
    | { kind: 'spendWorkspaceSummary'; workspaces: SpendWorkspaceBucket[] | undefined }
    | { kind: 'spendWorkspaceBucket'; bucket: SpendWorkspaceBucket }
    | { kind: 'spendWorkspaceEmpty' }
    | { kind: 'spendModelSummary'; models: SpendModelBucket[] | undefined; unattributed?: SpendModelBucket }
    | { kind: 'spendModelBucket'; bucket: SpendModelBucket }
    | { kind: 'spendModelEmpty' }
    | { kind: 'spendLastRefresh'; timestamp: number }
    | { kind: 'spendLoading'; history?: boolean }
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

function formatMessageCostMeter(nanoAiu: number): string {
    const aic = nanoAiu / NANO_AIU_PER_AIC;
    if (aic >= 2000) {
        const filledStars = Math.min(5, Math.floor((aic - 2000) / 500) + 1);
        return '★'.repeat(filledStars) + '☆'.repeat(5 - filledStars);
    }

    const filledSquares = aic >= 1400 ? 5 : aic >= 800 ? 4 : aic >= 300 ? 3 : aic >= 100 ? 2 : 1;
    return '■'.repeat(filledSquares) + '□'.repeat(5 - filledSquares);
}

function measuredTime(ms: number, known?: boolean): string {
    return known === false ? (ms > 0 ? `${formatDuration(ms)} recorded` : 'Not saved') : formatDuration(ms);
}

function callCount(turns: ModelTurnSummary[]): string {
    const calls = turns.filter(t => !t.usageKind || t.usageKind === 'call').length;
    const saved = turns.length - calls;
    return `${calls} ${calls === 1 ? 'call' : 'calls'}${saved ? ` + ${saved} saved usage` : ''}`;
}

export class UsageTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
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

    finishSpendRefresh(): void {
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

    requestSpendHistory(): void {
        this.spendHistoryRequested = true;
        if ((!this.spendSummary?.week || !this.spendSummary?.month) && this.spendRefreshMode !== 'full') {
            this.requestFullSpendSummary?.();
        }
        this._onDidChangeTreeData.fire();
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
            case 'agentGroup': {
                const turns = element.turns;
                const models = modelSequence(turns);
                const route = [...(this.summary?.routing ?? [])].reverse().find(r => r.agentId === element.agent?.id && r.timestamp <= (turns[0]?.timestamp ?? Infinity));
                const fusion = turns.some(t => t.isAuto) || route ? `Fusion${route?.tier ? ` (${route.tier})` : ''} → ` : '';
                const name = element.role === 'saved' ? 'Saved usage' : element.role === 'main' ? 'Main' : element.agent?.name ?? 'Subagent';
                const label = element.role === 'saved' ? name : `${name}${element.agent?.type ? ` (${element.agent.type})` : ''} · ${fusion}${models}${element.agent?.reasoningEffort ? ` · ${element.agent.reasoningEffort}` : ''}`;
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
                const cost = turns.reduce((n,t) => n + t.nanoAiu, 0);
                const duration = turns.reduce((n,t) => n + t.durationMs, 0);
                item.description = `${formatAic(cost)} AIC | ${callCount(turns)} | ${measuredTime(duration, turns.every(t => t.durationKnown !== false))}`;
                item.tooltip = `${label}\nRecorded cost includes any discount.\nLLM time: ${measuredTime(duration, turns.every(t => t.durationKnown !== false))}`;
                item.iconPath = new vscode.ThemeIcon(element.role === 'agent' ? 'rocket' : element.role === 'saved' ? 'database' : 'hubot');
                return item;
            }
            case 'modelSelections': {
                const item = new vscode.TreeItem('Model selections', vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `${element.summary.modelSelections?.length ?? 0} recorded`; return item;
            }
            case 'routingGroup': {
                const item = new vscode.TreeItem('Routing', vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `${element.routing.length} recorded decisions${element.signals?.length ? ` · ${element.signals.length} signals` : ''}`;
                item.iconPath = new vscode.ThemeIcon('git-branch'); return item;
            }
            case 'routingDecision': {
                const r = element.route;
                const item = new vscode.TreeItem(`${formatLocalTime(r.timestamp)} · ${r.chosenModel ?? 'Model not saved'}`, vscode.TreeItemCollapsibleState.Collapsed);
                item.description = r.tier ? `Fusion (${r.tier})` : 'Auto';
                item.tooltip = r.reason; return item;
            }
            case 'permissionGroup': {
                const c = element.checks;
                const item = new vscode.TreeItem('Permission checks', vscode.TreeItemCollapsibleState.Collapsed);
                const retries = c.filter(c => c.retry).length, failures = c.filter(c => c.failed).length;
                item.description = `${c.length} attempts · ${retries} retries · ${failures} failures · ${measuredTime(c.reduce((n,c)=>n+(c.durationMs??0),0),c.every(c=>c.durationMs!==undefined))}`;
                item.tooltip = 'Model diagnostics only; recorded billing is counted through usage records.';
                item.iconPath = new vscode.ThemeIcon('shield'); return item;
            }
            case 'spendSummary': {
                const s = element.summary;
                const item = new vscode.TreeItem('Spend Summary', vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `today ${formatAic(s.today.nanoAiu)} AIC | ${formatUsdEstimate(s.today.nanoAiu)}`;
                item.iconPath = new vscode.ThemeIcon(this.spendRefreshMode ? 'sync~spin' : 'graph-line');
                item.tooltip = 'Recorded usage across local Copilot sessions.';
                return item;
            }
            case 'spendBucket': {
                const b = element.bucket;
                const item = new vscode.TreeItem(
                    b.label,
                    b.workspaces || b.models ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = `${formatAic(b.nanoAiu)} AIC | ${formatUsdEstimate(b.nanoAiu)} | in:${formatRecordedTokens(b.inputTokens, b.tokensKnown)} out:${formatRecordedTokens(b.outputTokens, b.tokensKnown)}`;
                item.iconPath = new vscode.ThemeIcon('calendar');
                item.tooltip = [
                    `${formatAic(b.nanoAiu)} AIC`,
                    formatUsdEstimate(b.nanoAiu),
                    `Input tokens: ${formatRecordedTokens(b.inputTokens, b.tokensKnown)}`,
                    `Output tokens: ${formatRecordedTokens(b.outputTokens, b.tokensKnown)}`,
                    `Cached input tokens: ${formatRecordedTokens(b.cachedTokens, b.tokensKnown)}`,
                    `Fresh input tokens: ${formatRecordedTokens(Math.max(0, b.inputTokens - b.cachedTokens), b.tokensKnown)}`,
                    `${b.requestCount} parsed requests across ${b.sessionCount} ${b.sessionCount === 1 ? 'session' : 'sessions'}.`,
                ].join('\n');
                return item;
            }
            case 'spendWorkspaceSummary': {
                const count = element.workspaces?.length ?? 0;
                const item = new vscode.TreeItem(
                    'Workspace Summary',
                    element.workspaces ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = `${count} ${count === 1 ? 'workspace' : 'workspaces'}`;
                item.iconPath = new vscode.ThemeIcon('root-folder');
                return item;
            }
            case 'spendWorkspaceBucket': {
                const b = element.bucket;
                const item = new vscode.TreeItem(b.label, vscode.TreeItemCollapsibleState.None);
                item.description = `${formatAic(b.nanoAiu)} AIC | ${formatUsdEstimate(b.nanoAiu)} | ${b.requestCount} req`;
                item.iconPath = new vscode.ThemeIcon('root-folder');
                item.tooltip = [
                    `${formatAic(b.nanoAiu)} AIC`,
                    formatUsdEstimate(b.nanoAiu),
                    `Input tokens: ${formatRecordedTokens(b.inputTokens, b.tokensKnown)}`,
                    `Output tokens: ${formatRecordedTokens(b.outputTokens, b.tokensKnown)}`,
                    `Cached input tokens: ${formatRecordedTokens(b.cachedTokens, b.tokensKnown)}`,
                    `Fresh input tokens: ${formatRecordedTokens(Math.max(0, b.inputTokens - b.cachedTokens), b.tokensKnown)}`,
                    `${b.requestCount} parsed requests across ${b.sessionCount} ${b.sessionCount === 1 ? 'session' : 'sessions'}.`,
                ].join('\n');
                return item;
            }
            case 'spendWorkspaceEmpty': {
                const item = new vscode.TreeItem('No workspace usage', vscode.TreeItemCollapsibleState.None);
                item.description = 'none found';
                item.iconPath = new vscode.ThemeIcon('circle-slash');
                return item;
            }
            case 'spendModelSummary': {
                const count = element.models?.length ?? 0;
                const item = new vscode.TreeItem(
                    'Models',
                    element.models ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.description = `${count} ${count === 1 ? 'model' : 'models'}`;
                item.iconPath = new vscode.ThemeIcon('symbol-method');
                return item;
            }
            case 'spendModelBucket': {
                const b = element.bucket;
                const item = new vscode.TreeItem(b.label, vscode.TreeItemCollapsibleState.None);
                item.description = `${b.estimated ? '≈ ' : ''}${formatAic(b.nanoAiu)} AIC | ${formatUsdEstimate(b.nanoAiu)} | ${b.requestCount} req`;
                item.iconPath = new vscode.ThemeIcon('symbol-method');
                item.tooltip = [
                    `${formatAic(b.nanoAiu)} AIC`,
                    formatUsdEstimate(b.nanoAiu),
                    `Input tokens: ${formatRecordedTokens(b.inputTokens, b.tokensKnown)}`,
                    `Output tokens: ${formatRecordedTokens(b.outputTokens, b.tokensKnown)}`,
                    `Cached input tokens: ${formatRecordedTokens(b.cachedTokens, b.tokensKnown)}`,
                    `Fresh input tokens: ${formatRecordedTokens(Math.max(0, b.inputTokens - b.cachedTokens), b.tokensKnown)}`,
                    `${b.requestCount} parsed requests across ${b.sessionCount} ${b.sessionCount === 1 ? 'session' : 'sessions'}.`,
                    ...(b.estimated ? ['Includes estimated model allocation from saved token proportions; the prompt charge is unchanged.'] : []),
                ].join('\n');
                return item;
            }
            case 'spendModelEmpty': {
                const item = new vscode.TreeItem('No model usage', vscode.TreeItemCollapsibleState.None);
                item.description = 'none found';
                item.iconPath = new vscode.ThemeIcon('circle-slash');
                return item;
            }
            case 'spendLastRefresh': {
                const item = new vscode.TreeItem('Last refreshed', vscode.TreeItemCollapsibleState.None);
                item.description = formatLocalDateTime(element.timestamp);
                item.iconPath = new vscode.ThemeIcon('clock');
                return item;
            }
            case 'spendLoading': {
                const item = new vscode.TreeItem(element.history ? 'Loading spend history...' : 'Loading usage...', vscode.TreeItemCollapsibleState.None);
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
                const fusionSelection = s.modelSelections?.find(x => x.model === 'auto');
                const fusion = fusionSelection || s.routing?.length || s.userMessages.some(m => m.modelTurns.some(t=>t.isAuto)) ? `Fusion${fusionSelection?.autoTier ? ` (${fusionSelection.autoTier})` : ''} · ` : '';
                const mix = modelCostMix(sessionModelTurns(s));
                item.description = `${formatAic(s.totalNanoAiu)} AIC | ${fusion}${mix || 'Model not saved'} | ${s.userMessages.length} ${s.userMessages.length === 1 ? 'message' : 'messages'}`;
                item.iconPath = new vscode.ThemeIcon('graph');
                item.tooltip = [
                    `Session: ${s.sessionId}`,
                    `Total Input: ${formatRecordedTokens(s.totalInputTokens, s.tokensKnown)}`,
                    `Total Output: ${formatRecordedTokens(s.totalOutputTokens, s.tokensKnown)}`,
                    `Total Cached: ${formatRecordedTokens(s.totalCachedTokens, s.tokensKnown)}`,
                    `Total Tokens: ${formatRecordedTokens(s.totalTokens, s.tokensKnown)}`,
                    `Cost: ${formatAic(s.totalNanoAiu)} AIC`,
                    `Model Turns: ${s.modelTurnCount}`,
                    `Tool Calls: ${s.toolCallCount}`,
                    `Total LLM Time: ${measuredTime(s.totalDurationMs, s.durationKnown)}`,
                ].join('\n');
                return item;
            }
            case 'userMessage': {
                const m = element.message;
                const mergedNote = m.mergedMessages.length > 0
                    ? ` (+${m.mergedMessages.length})`
                    : '';
                const meter = formatMessageCostMeter(m.totalNanoAiu);
                // Fixed-width label: pad/truncate to 28 chars so descriptions align
                const rawPreview = (m.content || '(empty)') + mergedNote;
                const label = rawPreview.length > 28 ? rawPreview.slice(0, 27) + '…' : rawPreview.padEnd(28);
                const item = new vscode.TreeItem(
                    `${element.index + 1}: ${label}`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                const main = m.modelTurns.filter(t=>!t.agentId && (!t.usageKind || t.usageKind === 'call'));
                const mainIds = new Set(main.map(t=>canonicalModelId(t.model)));
                const otherModels = [...new Set(m.modelTurns.filter(t=>t.agentId && !mainIds.has(canonicalModelId(t.model))).map(modelLabel))];
                const auto = main.some(t=>t.isAuto) || this.summary?.routing?.some(r=>r.owner===m.spanId && !r.agentId);
                const models = `${auto ? 'Fusion → ' : ''}${modelSequence(main) || 'Saved usage'}${otherModels.length ? ` + ${otherModels.join(', ')} (subagents)` : ''}`;
                item.description = `${formatAic(m.totalNanoAiu)} AIC | ${models} | ${callCount(m.modelTurns)}  ${meter}`;
                item.iconPath = new vscode.ThemeIcon('comment');
                item.tooltip = [
                    `User Message ${element.index + 1}`,
                    `"${m.content}"`,
                    m.mergedMessages.length > 0 ? `(includes ${m.mergedMessages.length} merged continuation message${m.mergedMessages.length > 1 ? 's' : ''})` : '',
                    `---`,
                    `Input Tokens: ${formatRecordedTokens(m.totalInputTokens, m.tokensKnown)}`,
                    `Output Tokens: ${formatRecordedTokens(m.totalOutputTokens, m.tokensKnown)}`,
                    `Cached Tokens: ${formatRecordedTokens(m.totalCachedTokens, m.tokensKnown)}`,
                    `Total Tokens: ${formatRecordedTokens(m.totalTokens, m.tokensKnown)}`,
                    `Cost: ${formatAic(m.totalNanoAiu)} AIC`,
                    `Model calls: ${callCount(m.modelTurns)}`,
                    `Tool Calls: ${m.toolCalls.length}`,
                    `LLM Time: ${measuredTime(m.totalDurationMs, m.durationKnown)}`,
                ].filter(Boolean).join('\n');
                return item;
            }
            case 'turnsGroup': {
                const m = element.message;
                const totalTools = m.modelTurns.reduce((s, t) => s + t.toolCalls.length, 0);
                const item = new vscode.TreeItem(
                    `${callCount(m.modelTurns)}`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${totalTools} tool calls | ${measuredTime(m.totalDurationMs, m.durationKnown)}`;
                item.iconPath = new vscode.ThemeIcon('layers');
                return item;
            }
            case 'modelTurn': {
                const t = element.turn;
                const cacheNote = t.inputTokens > 0 ? ` | ${(t.cacheHitRatio * 100).toFixed(0)}%` : '';

                // Generate a label like Copilot Chat does: show what the turn did
                let turnLabel: string;
                let turnIcon: vscode.ThemeIcon;
                if (t.usageKind === 'saved' || t.usageKind === 'adjustment') {
                    turnLabel = t.usageKind === 'adjustment' ? 'Other saved usage' : 'Saved usage without call detail';
                    turnIcon = new vscode.ThemeIcon('database');
                } else if (t.toolCalls.length === 0) {
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

                const main = this.summary?.userMessages[element.msgIndex]?.modelTurns.find(t=>!t.agentId && t.usageKind !== 'adjustment');
                if (main && canonicalModelId(t.model) !== canonicalModelId(main.model)) { turnLabel += ` · ${modelLabel(t)}`; }
                if (t.reasoningEffort && t.reasoningEffort !== main?.reasoningEffort) { turnLabel += ` · ${t.reasoningEffort}`; }
                const item = new vscode.TreeItem(
                    turnLabel,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.description = `${formatAic(t.nanoAiu)} AIC | in:${formatRecordedTokens(t.inputTokens, t.tokensKnown)} out:${formatRecordedTokens(t.outputTokens, t.tokensKnown)}${cacheNote}`;
                item.iconPath = turnIcon;
                item.tooltip = [
                    `Model: ${modelLabel(t)} (${t.model})`,
                    `Request: ${t.debugName}`,
                    `Input: ${formatRecordedTokens(t.inputTokens, t.tokensKnown)}`,
                    `Output: ${formatRecordedTokens(t.outputTokens, t.tokensKnown)}`,
                    `Cached: ${formatRecordedTokens(t.cachedTokens, t.tokensKnown)}`,
                    `Total: ${formatRecordedTokens(t.totalTokens, t.tokensKnown)}`,
                    `Cost: ${formatAic(t.nanoAiu)} AIC`,
                    `Duration: ${measuredTime(t.durationMs, t.durationKnown)}`,
                    `TTFT: ${measuredTime(t.ttftMs, t.ttftKnown)}`,
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
                if (c.status === 'interrupted') { descriptionParts.push('Interrupted'); }
                else if (c.status === 'pending') { descriptionParts.push('Completion not recorded'); }
                else if (c.durationMs >= 0) {
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
                if (c.isSubagent) {
                    item.iconPath = new vscode.ThemeIcon('rocket');
                    if (c.subagentInProgress) {
                        descriptionParts.push('in progress');
                    }
                    if (c.subagentSummary) {
                        descriptionParts.push(`${formatAic(c.subagentSummary.totalNanoAiu)} AIC`);
                        descriptionParts.push(`${c.subagentSummary.modelTurnCount} turns`);
                    }
                } else {
                    item.iconPath = new vscode.ThemeIcon('wrench');
                }
                item.description = descriptionParts.join(' | ');
                item.tooltip = [
                    `Tool: ${c.name}`,
                    c.toolKind ? `Kind: ${c.toolKind}` : undefined,
                    c.source ? `Source: ${c.source}` : undefined,
                    c.resultCount !== undefined ? `Results: ${formatNumber(c.resultCount)}` : undefined,
                    c.toolCallId ? `Call ID: ${c.toolCallId}` : undefined,
                    c.subagentInProgress ? 'Subagent: in progress' : undefined,
                    `Label: ${c.displayLabel}`,
                ].filter(Boolean).join('\n');
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
                item.tooltip = `SpanId: ${info.spanId}\nTimestamp: ${formatLocalTime(info.timestamp)}`;
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
            } else if (this.spendRefreshMode) {
                roots.push({ kind: 'spendLoading' });
            }
            if (this.summary) {
                roots.push({ kind: 'session', summary: this.summary });
            }
            return roots;
        }

        if (element.kind === 'spendSummary') {
            const children: TreeItemData[] = [
                { kind: 'spendBucket', bucket: element.summary.today },
            ];

            if (element.summary.week && element.summary.month) {
                children.push(
                    { kind: 'spendBucket', bucket: element.summary.week },
                    { kind: 'spendBucket', bucket: element.summary.month }
                );
            } else if (this.spendHistoryRequested && this.spendRefreshMode) {
                children.push({ kind: 'spendLoading', history: true });
            }

            children.push({ kind: 'spendLastRefresh', timestamp: element.summary.generatedAt });
            return children;
        }

        if (element.kind === 'spendBucket') {
            const children: TreeItemData[] = [];
            if (element.bucket.label === 'Today' && this.spendSummary) {
                const at = this.spendSummary.generatedAt;
                const midnight = new Date(at); midnight.setHours(0, 0, 0, 0);
                const hours = (at - midnight.getTime()) / 3_600_000;
                if (hours > 0) { children.push({ kind: 'stat', label: 'Average since midnight', value: `${formatAic(element.bucket.nanoAiu / hours)} AIC/hour` }); }
            }
            if (element.bucket.workspaces) {
                children.push({ kind: 'spendWorkspaceSummary', workspaces: element.bucket.workspaces });
            }
            if (element.bucket.models) {
                children.push({ kind: 'spendModelSummary', models: element.bucket.models, unattributed: element.bucket.unattributed });
            }
            return children;
        }

        if (element.kind === 'spendWorkspaceSummary') {
            const workspaces = element.workspaces;
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

        if (element.kind === 'spendModelSummary') {
            const models = element.models;
            if (!models) {
                return [];
            }
            const children: TreeItemData[] = models.map(bucket => ({kind:'spendModelBucket',bucket}));
            if (element.unattributed) { children.push({kind:'stat',label:'Unattributed usage',value:`${formatAic(element.unattributed.nanoAiu)} AIC · model not recorded`}); }
            return children.length ? children : [{kind:'spendModelEmpty'}];
        }

        if (!this.summary) {
            return [];
        }

        switch (element.kind) {
            case 'session': {
                const s = element.summary;
                const stats: TreeItemData[] = [
                    { kind: 'stat', label: 'Models by cost', value: modelCostMix(sessionModelTurns(s)) || 'Not saved' },
                    { kind: 'stat', label: 'Total Cost', value: `${formatAic(s.totalNanoAiu)} AIC` },
                    { kind: 'stat', label: 'Estimated USD', value: formatUsdEstimate(s.totalNanoAiu) },
                    ...(s.sourceType === 'chatSession' && !this.debugLogsEnabled
                        ? [{ kind: 'stat' as const, label: 'Enable Debug Logs', value: 'for richer per-turn data' }]
                        : []),
                    { kind: 'stat', label: 'Total Tokens', value: `${formatRecordedTokens(s.totalTokens, s.tokensKnown)} (in:${formatRecordedTokens(s.totalInputTokens, s.tokensKnown)} out:${formatRecordedTokens(s.totalOutputTokens, s.tokensKnown)} cache:${formatRecordedTokens(s.totalCachedTokens, s.tokensKnown)})` },
                    { kind: 'stat', label: 'Total LLM Time', value: measuredTime(s.totalDurationMs, s.durationKnown) },
                    { kind: 'stat', label: 'Model Calls / Tool Calls', value: `${s.modelTurnCount} / ${s.toolCallCount}` },
                ];
                const calls = s.userMessages.flatMap(m => m.modelTurns);
                const childCalls = calls.filter(t => t.agentId);
                if (childCalls.length) { stats.push({ kind: 'stat', label: 'Recorded subagent cost (included)', value: `${formatAic(childCalls.reduce((n, t) => n + t.nanoAiu, 0))} AIC · ${childCalls.length} calls` }); }
                if (s.compactionCount) { stats.push({ kind: 'stat', label: 'Compactions', value: String(s.compactionCount) }); }
                if (s.hookDurationMs) { stats.push({ kind: 'stat', label: 'Recorded hook time', value: formatDuration(s.hookDurationMs) }); }
                if (s.sourceType === 'background') { stats.push({ kind: 'stat', label: 'Recorded tool time', value: formatDuration(s.userMessages.reduce((n, m) => n + m.toolCalls.reduce((n, t) => n + t.durationMs, 0), 0)) }); }
                if (s.codeChanges) {
                    const c = s.codeChanges;
                    stats.push({ kind: 'stat', label: 'Saved code changes', value: `${c.linesAdded ?? '?'} added · ${c.linesRemoved ?? '?'} removed · ${c.filesChanged ?? '?'} files` });
                }
                const ranked = s.userMessages.map((m, i) => ({ m, i })).filter(({m}) => m.totalNanoAiu > 0).sort((a, b) => b.m.totalNanoAiu - a.m.totalNanoAiu).slice(0, 5);
                if (ranked.length > 1) { stats.push({ kind: 'stat', label: 'Most expensive messages', value: ranked.map(({m, i}) => `#${i + 1}: ${formatAic(m.totalNanoAiu)} AIC`).join(' · ') }); }
                if (s.routing?.length) { stats.push({ kind: 'routingGroup', routing: s.routing }); }
                if (s.modelSelections?.length) { stats.push({ kind: 'modelSelections', summary: s }); }
                const unassignedChecks = s.permissionChecks?.filter(c => !c.owner) ?? [];
                if (unassignedChecks.length) { stats.push({ kind: 'permissionGroup', checks: unassignedChecks }); }
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
                children.push({ kind: 'stat', label: 'Tokens', value: `in:${formatRecordedTokens(m.totalInputTokens, m.tokensKnown)} out:${formatRecordedTokens(m.totalOutputTokens, m.tokensKnown)} cache:${formatRecordedTokens(m.totalCachedTokens, m.tokensKnown)}` });
                children.push({ kind: 'stat', label: 'Context at Start', value: m.contextKnown === false ? 'Not saved' : `~${formatNumber(estimateTokens(m.contextCharsAtStart))} tokens (${formatNumber(m.contextCharsAtStart)} chars)` });
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
                if (this.summary?.sourceType === 'background' && m.modelTurns.some(t => t.usageKind === 'call')) {
                    const main = m.modelTurns.filter(t => t.usageKind === 'call' && !t.agentId);
                    if (main.length) { children.push({ kind: 'agentGroup', role: 'main', turns: main, msgIndex: element.index }); }
                    for (const id of new Set(m.modelTurns.map(t => t.agentId).filter(Boolean))) {
                        const agent = this.summary.agents?.find(a => a.id === id) ?? { id: id!, name: `Subagent ${id!.slice(0,8)}` };
                        children.push({ kind: 'agentGroup', role: 'agent', agent, turns: m.modelTurns.filter(t => t.agentId === id), msgIndex: element.index });
                    }
                    const saved = m.modelTurns.filter(t => t.usageKind !== 'call');
                    if (saved.length) { children.push({ kind: 'agentGroup', role: 'saved', turns: saved, msgIndex: element.index }); }
                } else { children.push({ kind: 'turnsGroup', message: m, msgIndex: element.index }); }
                const checks = this.summary?.permissionChecks?.filter(c => c.owner === m.spanId) ?? [];
                if (checks.length) { children.push({ kind: 'permissionGroup', checks }); }
                const mainModels = new Set(m.modelTurns.filter(t => t.isAuto && !t.agentId).map(t => canonicalModelId(t.model)));
                const decisions = this.summary?.routing?.filter(r => r.owner === m.spanId) ?? [];
                const signals: string[] = [];
                if (mainModels.size > 1) { signals.push(`${mainModels.size} Auto models recorded in this prompt`); }
                if (decisions.filter(r=>!r.agentId).length > 1) { signals.push('Multiple main-agent routing decisions'); }
                const itemized = m.modelTurns.filter(t => new Set(t.tokenDetails?.map(d=>d.model).filter(Boolean)).size > 1);
                if (itemized.length) { signals.push(`${itemized.length} calls contain charges for multiple models`); }
                if (decisions.length || signals.length) { children.push({ kind: 'routingGroup', routing: decisions, signals }); }
                // Merged continuations info
                if (m.mergedMessages.length > 0) {
                    children.push({ kind: 'mergedInfo', message: m, msgIndex: element.index });
                }
                return children;
            }
            case 'agentGroup': {
                const children: TreeItemData[] = [];
                const a = element.agent;
                if (a?.type) { children.push({ kind: 'stat', label: 'Agent type', value: a.type }); }
                if (a?.modelSelectionSource) { children.push({ kind: 'stat', label: 'Model selection', value: a.modelSelectionSource }); }
                if (a) {
                    children.push({ kind: 'stat', label: 'Elapsed time', value: a.durationMs === undefined ? 'Not saved' : formatDuration(a.durationMs) });
                    if (a.toolCalls !== undefined) { children.push({ kind: 'stat', label: 'Reported tool calls', value: String(a.toolCalls) }); }
                    if (a.tokens !== undefined) { children.push({ kind: 'stat', label: 'Reported tokens', value: formatNumber(a.tokens) }); }
                    const standard = element.turns.filter(t => t.isAuto === false);
                    if (standard.length) { children.push({ kind: 'stat', label: 'Non-Auto cost (included)', value: `${formatAic(standard.reduce((n,t)=>n+t.nanoAiu,0))} AIC` }); }
                }
                return [...children, ...element.turns.map((turn,i) => ({ kind: 'modelTurn' as const, turn, turnIndex:i, msgIndex:element.msgIndex }))];
            }
            case 'modelSelections': return (element.summary.modelSelections ?? []).map(s=>({kind:'stat' as const,label:`${formatLocalTime(s.timestamp)} · ${s.agentId || s.source === 'agent' ? 'Subagent' : 'Main'}`,value:`${s.model}${s.reasoningEffort ? ` · ${s.reasoningEffort}` : ''}${s.contextTier ? ` · ${s.contextTier}` : ''} · ${s.source}`}));
            case 'routingGroup': return [...element.routing.map(route => ({kind:'routingDecision' as const,route})), ...(element.signals ?? []).map(value=>({kind:'stat' as const,label:'Observed routing signal',value}))];
            case 'routingDecision': {
                const r = element.route;
                return [
                    {kind:'stat', label:'Reason', value:r.reason ?? 'Not saved'},
                    {kind:'stat', label:'Routing method', value:r.method ?? 'Not saved'},
                    {kind:'stat', label:'Available models', value:r.availableModels?.join(', ') || 'Not saved'},
                    {kind:'stat', label:'Candidates', value:r.candidates.join(', ') || 'Not saved'},
                    {kind:'stat', label:'Scores', value:r.scores ? Object.entries(r.scores).map(([k,v])=>`${k}: ${v}`).join(' · ') : 'Not saved'},
                    {kind:'stat', label:'Routing time', value:r.latencyMs === undefined ? 'Not saved' : formatDuration(r.latencyMs)},
                ];
            }
            case 'permissionGroup': return element.checks.map(c => ({kind:'stat' as const, label:c.model,
                value:`${c.failed ? 'Failed' : 'Completed'}${c.retry ? ' · retry' : ''} · ${c.durationMs === undefined ? 'Time not saved' : formatDuration(c.durationMs)} · ${c.listedFree ? 'Listed free' : 'Diagnostics only'}${c.inputTokens !== undefined ? ` · in:${formatNumber(c.inputTokens)}` : ''}${c.outputTokens !== undefined ? ` out:${formatNumber(c.outputTokens)}` : ''}${c.cachedTokens !== undefined ? ` cache:${formatNumber(c.cachedTokens)}` : ''}${c.cacheWriteTokens !== undefined ? ` write:${formatNumber(c.cacheWriteTokens)}` : ''}`}));
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
                const children: TreeItemData[] = [
                    { kind: 'stat', label: 'Cost', value: `${formatAic(t.nanoAiu)} AIC` },
                    { kind: 'stat', label: 'Tokens', value: `in:${formatRecordedTokens(t.inputTokens, t.tokensKnown)} out:${formatRecordedTokens(t.outputTokens, t.tokensKnown)} cache:${formatRecordedTokens(t.cachedTokens, t.tokensKnown)}` },
                    { kind: 'stat', label: 'Input breakdown', value: t.tokensKnown === false ? 'Not saved' : `${formatRecordedTokens(t.cachedTokens, t.tokensKnown)} cache read · ${t.cacheWriteTokens === undefined ? 'cache write not saved' : `${formatNumber(t.cacheWriteTokens)} cache write · ${formatNumber(t.freshTokens)} normal input`}` },
                    { kind: 'stat', label: 'Duration / TTFT', value: `${measuredTime(t.durationMs, t.durationKnown)} / ${measuredTime(t.ttftMs, t.ttftKnown)}` },
                ];
                for (const detail of t.tokenDetails ?? []) {
                    const priced = typeof detail.costPerBatch === 'number' && (detail.batchSize ?? 0) > 0;
                    children.push({ kind: 'stat', label: `Cost: ${detail.tokenType}`, value: `${formatNumber(detail.tokenCount)} tokens${priced ? ` · ${formatTokenCost(detail.tokenCount * detail.costPerBatch! / detail.batchSize!)} AIC` : ''}` });
                }
                if (t.isByok) { children.push({ kind: 'stat', label: 'Billing', value: 'Own API key (BYOK)' }); }
                if (t.contextTier) { children.push({ kind: 'stat', label: 'Context tier', value: t.contextTier }); }
                if (t.responseModel && t.responseModel !== t.model) { children.push({ kind: 'stat', label: 'Response model', value: t.responseModel }); }
                if (t.maxPromptTokens) { children.push({ kind: 'stat', label: 'Context fill', value: `${(100 * t.inputTokens / t.maxPromptTokens).toFixed(1)}% · ${formatRecordedTokens(t.inputTokens, t.tokensKnown)} / ${formatNumber(t.maxPromptTokens)}` }); }
                if (t.toolTokenCount !== undefined) { children.push({ kind: 'stat', label: 'Tool definitions', value: `${formatNumber(t.toolTokenCount)} tokens${t.availableToolCount !== undefined ? ` · ${t.availableToolCount} tools` : ''}` }); }
                if (t.reasoningTokens !== undefined || t.reasoningEffort) { children.push({ kind: 'stat', label: 'Reasoning', value: `${t.reasoningTokens === undefined ? 'Tokens not saved' : formatNumber(t.reasoningTokens) + ' tokens'}${t.reasoningEffort ? ` · ${t.reasoningEffort}` : ''}` }); }
                if (t.interTokenLatencyMs && t.interTokenLatencyMs > 0) { children.push({ kind: 'stat', label: 'Output speed', value: `${(1000 / t.interTokenLatencyMs).toFixed(1)} tokens/s` }); }
                if (t.finishReason) { children.push({ kind: 'stat', label: 'Finish reason', value: t.finishReason }); }
                if (t.isAuto !== undefined) { children.push({ kind: 'stat', label: 'Auto routing', value: t.isAuto ? 'Yes' : 'No' }); }
                if (t.cachePreviouslyExpired) { children.push({ kind: 'stat', label: 'Previous cache', value: 'Expired before this call' }); }
                const billedModels = [...new Set((t.tokenDetails ?? []).map(d => d.model ?? t.model))];
                if (billedModels.length > 1) { children.push({ kind: 'stat', label: 'Multiple billed models', value: billedModels.join(', ') }); }
                if (t.cacheExpiresAt) { children.push({ kind: 'stat', label: 'Cache expires', value: new Date(t.cacheExpiresAt).toLocaleString() }); }
                if (t.premiumRequests !== undefined) { children.push({ kind: 'stat', label: 'Premium request units', value: String(t.premiumRequests) }); }
                if (t.agentId) { children.push({ kind: 'stat', label: 'Subagent', value: t.agentId }); }
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
                        ...(c.subagentInProgress
                            ? [{ kind: 'stat' as const, label: 'Subagent Status', value: 'in progress' }]
                            : []),
                        { kind: 'stat', label: 'Subagent Cost', value: `${formatAic(s.totalNanoAiu)} AIC` },
                        { kind: 'stat', label: 'Subagent Tokens', value: `in:${formatRecordedTokens(s.totalInputTokens, s.tokensKnown)} out:${formatRecordedTokens(s.totalOutputTokens, s.tokensKnown)}` },
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
                    { kind: 'stat', label: 'Tokens', value: `in:${formatRecordedTokens(t.inputTokens, t.tokensKnown)} out:${formatRecordedTokens(t.outputTokens, t.tokensKnown)} cache:${formatRecordedTokens(t.cachedTokens, t.tokensKnown)}` },
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

function createSessionPickItems(
    sessions: (SessionCandidate & { wsDir: string })[],
    currentWsSessionId: string | undefined,
    hasOlder: boolean,
    loadedDays: number
): SessionPickItem[] {
    const items: SessionPickItem[] = sessions.map(session => {
        const title = session.title;
        const timeStr = formatLocalDateTime(session.modifiedTime);
        const isCurrent = session.id === currentWsSessionId;
        const currentTag = isCurrent ? ' (current session)' : '';
        return {
            itemType: 'session',
            label: `${title || session.id.slice(0, 8) + '...'}${currentTag}`,
            description: `${session.wsDir} • ${timeStr}${title ? ' (' + session.id.slice(0, 8) + ')' : ''}`,
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
    const options = () => ({
        storagePath: context.storageUri?.fsPath,
        globalStoragePath: context.globalStorageUri?.fsPath,
        searchRoots: vscode.workspace.getConfiguration('copilotUsageTracker').get<string[]>('searchRoots', []),
        maxDepth: vscode.workspace.getConfiguration('copilotUsageTracker').get<number>('maxSearchDepth', 6),
    });
    const client = new UsageClient(options());
    const output = vscode.window.createOutputChannel('Copilot Usage');
    const report = (error: unknown) => output.appendLine(`${new Date().toISOString()} ${String(error)}`);
    const treeProvider = new UsageTreeProvider();
    const spendFileCachePath = getSpendFileCachePath(context.globalStorageUri?.fsPath);
    const treeView = vscode.window.createTreeView('copilotUsageTree', { treeDataProvider: treeProvider, showCollapseAll: true });
    let disposed = false;
    let currentSessionCandidate: SessionCandidate | undefined;
    let selectionGeneration = 0;
    let sessionWatchers: vscode.FileSystemWatcher[] = [];
    const spendWatchers = new Map<string, vscode.FileSystemWatcher>();
    let pendingSession = false;
    let pendingSpend = false;
    let pendingDiscovery = false;
    let forceSpend = false;
    let initialSessionReconciled = false;
    const refreshScheduler = new RefreshScheduler(AUTO_REFRESH_MS, async () => {
        const session = pendingSession, spend = pendingSpend, discover = pendingDiscovery, force = forceSpend;
        pendingSession = pendingSpend = pendingDiscovery = forceSpend = false;
        // A failure in one source must not prevent the other totals from updating.
        if (discover) { try { await watchSpendSources(true); } catch (error) { report(error); } }
        if (session && !disposed) { try { await refreshCurrentSession(); } catch (error) { report(error); } }
        if (spend && !disposed) { await refreshSpend(force); }
    }, report);

    function scheduleRefresh(jobs: { session?: boolean; spend?: boolean; discover?: boolean; force?: boolean }, immediate = false) {
        if (disposed) { return; }
        pendingSession ||= !!jobs.session;
        pendingSpend ||= !!jobs.spend;
        pendingDiscovery ||= !!jobs.discover;
        forceSpend ||= !!jobs.force;
        refreshScheduler.request(immediate);
    }
    async function refreshSpend(refresh: boolean) {
        const mode = treeProvider.hasSpendHistoryBeenRequested() ? 'full' : 'today';
        treeProvider.setSpendRefreshing(mode);
        try {
            const summary = await client.request('spend', mode, refresh, spendFileCachePath);
            if (!disposed) {
                treeProvider.setSpendSummary(summary);
            }
        } finally { if (!disposed) { treeProvider.finishSpendRefresh(); } }
        // Paint Today before opening historical databases. The worker then completes
        // reverse lookup and reconciles any SDK-only first paint, even while idle.
        if (!disposed && !initialSessionReconciled) {
            initialSessionReconciled = true;
            try {
                await client.request('indexHistory');
                if (disposed) { return; }
                await refreshCurrentSession();
                if (mode === 'today') {
                    const summary = await client.request('spend', 'today', true, spendFileCachePath);
                    if (!disposed) { treeProvider.setSpendSummary(summary); }
                }
            } catch (error) { initialSessionReconciled = false; report(error); }
        }
    }
    async function refreshCurrentSession() {
        const candidate = currentSessionCandidate;
        const generation = selectionGeneration;
        if (!candidate) { return; }
        const parsed = await client.request('parse', candidate);
        if (parsed && !disposed && generation === selectionGeneration) {
            // Keep the last complete selection while a live SQLite transaction prevents a safe read.
            if (parsed.summary.usageNotes?.some(note => note.includes('unavailable or unreadable'))) { return; }
            treeProvider.setSummary(parsed.summary);
            setCurrentGraph(parsed.summary);
            // Provider metadata can attach a new SDK events directory mid-session.
            await watchCurrentSession(parsed.sourceFile, generation);
        }
    }
    async function watchSpendSources(refresh = false) {
        const dirs = await client.request('directories', refresh);
        if (disposed) { return; }
        const stores: [string, string][] = [
            ...dirs.debug.map(dir => [dir, '*/*.jsonl'] as [string, string]),
            ...dirs.chat.map(dir => [dir, '*.jsonl'] as [string, string]),
            ...dirs.cli.map(dir => [dir, '*/*.{jsonl,json}'] as [string, string]),
            ...dirs.agent.map(dir => [dir, '*/session.db{,-wal}'] as [string, string]),
        ];
        const active = new Set(stores.map(([dir]) => dir));
        for (const [dir, watcher] of spendWatchers) {
            if (!active.has(dir)) { watcher.dispose(); spendWatchers.delete(dir); }
        }
        for (const [dir, glob] of stores) {
            if (spendWatchers.has(dir)) { continue; }
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
            const changed = () => scheduleRefresh({ spend: true, force: true });
            watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed);
            spendWatchers.set(dir, watcher);
        }
    }
    async function watchCurrentSession(file: string, generation: number) {
        const dirs = await client.request('dependencies', file);
        if (disposed || generation !== selectionGeneration) { return; }
        sessionWatchers.forEach(watcher => watcher.dispose());
        sessionWatchers = [];
        const changed = () => scheduleRefresh({ session: true, spend: true, force: true });
        for (const dir of dirs) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.{jsonl,json,db,db-wal}'));
            watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed);
            sessionWatchers.push(watcher);
        }
    }
    async function load(candidate?: SessionCandidate) {
        const generation = ++selectionGeneration;
        const result = candidate
            ? { candidate, parsed: await client.request('parse', candidate) }
            : await client.request('autoLoad');
        if (disposed || generation !== selectionGeneration) { return; }
        if (!result?.parsed) {
            if (candidate) { throw new Error('No usage data found in the selected session.'); }
            treeProvider.setSummary(undefined);
            await vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', false);
            return;
        }
        currentSessionCandidate = { ...result.candidate, mainJsonl: result.parsed.sourceFile };
        treeProvider.setSummary(result.parsed.summary);
        setCurrentGraph(result.parsed.summary);
        await vscode.commands.executeCommand('setContext', 'copilotUsageTracker.hasSession', true);
        await watchCurrentSession(result.parsed.sourceFile, generation);
        return result.parsed;
    }
    treeProvider.setFullSpendSummaryLoader(() => scheduleRefresh({ spend: true }, true));
    const interval = setInterval(() => scheduleRefresh({ discover: true, spend: true, force: true }), DISCOVERY_REFRESH_MS);
    context.subscriptions.push(client, output, treeView,
        treeView.onDidExpandElement(event => { if (event.element.kind === 'spendSummary') { treeProvider.requestSpendHistory(); } }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(DEBUG_LOGS_SETTING)) { treeProvider.setDebugLogsEnabled(isDebugLogsSettingEnabled()); }
            if (event.affectsConfiguration('copilotUsageTracker')) {
                void (async () => {
                    await client.request('configure', options());
                    await watchSpendSources();
                    if (currentSessionCandidate) { await load(currentSessionCandidate); }
                    scheduleRefresh({ spend: true, force: true }, true);
                })().catch(report);
            }
        }),
        new vscode.Disposable(() => {
            disposed = true;
            refreshScheduler.dispose();
            clearInterval(interval);
            sessionWatchers.forEach(w => w.dispose());
            spendWatchers.forEach(w => w.dispose());
        }),
    );
    // Activation returns immediately; even a cold, multi-GB scan stays off the host thread.
    treeProvider.setSpendRefreshing('today');
    void (async () => {
        const cached = await client.request('cachedSpend', spendFileCachePath);
        if (cached && !disposed) { treeProvider.setSpendSummary(cached); treeProvider.setSpendRefreshing('today'); }
        await watchSpendSources();
        await load();
        scheduleRefresh({ spend: true }, true);
    })().catch(error => {
        report(error);
        if (!disposed) { treeProvider.finishSpendRefresh(); }
    });
    registerChatParticipant(context,
        async days => (await client.request('list', days)).sessions,
        async candidate => (await client.request('parse', candidate))?.summary);

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotUsageTracker.analyzeSession', async () => {
            try { const parsed = await load(); if (parsed) { vscode.window.showInformationMessage('Copilot Usage: Loaded most recent session.'); } }
            catch (error) { report(error); vscode.window.showErrorMessage(String(error)); }
        }),
        vscode.commands.registerCommand('copilotUsageTracker.refresh', async () => {
            try { await load(); await watchSpendSources(true); scheduleRefresh({ spend: true, force: true }, true); }
            catch (error) { report(error); vscode.window.showErrorMessage(String(error)); }
        }),
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
            if (isPickingSession) { return; }
            await setPickingSession(true);
            const picker = vscode.window.createQuickPick<SessionPickItem>();
            const listeners: vscode.Disposable[] = [];
            let closed = false;
            let days = INITIAL_PICK_DAYS;
            picker.matchOnDescription = picker.matchOnDetail = picker.ignoreFocusOut = true;
            picker.title = 'Pick Copilot Chat Session';
            async function refreshItems() {
                picker.busy = true; picker.enabled = false;
                picker.placeholder = `Loading sessions from the last ${days} days...`;
                try {
                    const result = await client.request('list', days);
                    if (closed) { return; }
                    picker.items = createSessionPickItems(result.sessions, result.currentId, result.hasOlder, days);
                    picker.placeholder = result.sessions.length ? 'Select a chat session' : `No sessions found in the last ${days} days`;
                } catch (error) {
                    report(error);
                    if (!closed) { picker.placeholder = 'Could not load sessions. Close and retry.'; }
                } finally { if (!closed) { picker.enabled = true; picker.busy = false; } }
            }
            listeners.push(picker.onDidHide(() => {
                closed = true;
                listeners.forEach(d => d.dispose()); picker.dispose();
                void setPickingSession(false);
            }), picker.onDidAccept(async () => {
                const picked = picker.selectedItems[0];
                if (!picked) { return; }
                if (picked.itemType === 'loadMore') { days += PICK_LOAD_MORE_DAYS; await refreshItems(); return; }
                picker.busy = true; picker.enabled = false; picker.placeholder = 'Loading selected session...';
                try {
                    await load(picked.session);
                    if (!closed) { picker.hide(); }
                } catch (error) { report(error); if (!closed) { vscode.window.showErrorMessage(String(error)); } }
                finally { if (!closed) { picker.enabled = true; picker.busy = false; } }
            }));
            picker.show();
            await refreshItems();
        }),
    );
}
export function deactivate() {}
