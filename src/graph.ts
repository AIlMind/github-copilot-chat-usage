/**
 * SessionGraph: A typed, queryable interface over a parsed SessionSummary.
 *
 * Design goals:
 * - Immutable after construction (safe to share across consumers)
 * - Lazy computation with caching (compute expensive aggregates only once)
 * - Serializable to a compact LLM-friendly format (for chat participant)
 * - Stable interface: adding new query methods won't break existing consumers
 * - Message text capped for LLM context efficiency
 */

import {
    SessionSummary,
    UserMessageSummary,
    ModelTurnSummary,
    ToolCallSummary,
    PromptComposition,
    formatNumber,
    formatAic,
    formatDuration,
    estimateTokens,
} from './parser';

// ---- Public types (stable contract for consumers) ----

export interface GraphMessage {
    index: number;
    content: string; // capped at 100 words
    timestamp: number;
    costAic: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    durationMs: number;
    turnCount: number;
    toolCallCount: number;
    continuations: number;
    turns: GraphTurn[];
}

export interface GraphTurn {
    index: number;
    model: string;
    debugName: string;
    costAic: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    freshTokens: number;
    cacheHitRatio: number;
    durationMs: number;
    ttftMs: number;
    toolCalls: GraphToolCall[];
}

export interface GraphSubagent {
    sessionId: string;
    title?: string;
    inProgress: boolean;
    costAic: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    durationMs: number;
    messageCount: number;
    modelTurnCount: number;
    toolCallCount: number;
    messages: GraphMessage[];
}

export interface GraphToolCall {
    name: string;
    displayLabel: string;
    durationMs: number;
    isSubagent: boolean;
    source?: string;
    toolKind?: string;
    resultCount?: number;
    subagentCostAic?: number;
    subagentInProgress?: boolean;
    subagent?: GraphSubagent;
}

export interface ToolUsageEntry {
    name: string;
    count: number;
    totalDurationMs: number;
    tier: 'heavy' | 'medium' | 'light' | 'never';
}

export interface CommandEntry {
    executable: string;
    count: number;
}

export interface SessionStats {
    sessionId: string;
    title?: string;
    totalCostAic: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalTokens: number;
    totalDurationMs: number;
    messageCount: number;
    modelTurnCount: number;
    toolCallCount: number;
    avgCostPerMessage: number;
    avgTurnsPerMessage: number;
    cacheHitRatio: number;
}

export interface RiskFlag {
    messageIndex: number;
    turnIndex: number;
    toolCall: string;
    reason: string;
    severity: 'low' | 'medium' | 'high';
}

export interface GraphComparison {
    sessionA: SessionStats;
    sessionB: SessionStats;
    costDelta: number;
    tokenDelta: number;
    turnDelta: number;
    toolUsageDiff: { name: string; countA: number; countB: number }[];
    commandDiff: { executable: string; countA: number; countB: number }[];
}

export interface SerializeOptions {
    includeMessages?: boolean;
    maxMessages?: number;
    includeSubagents?: boolean;
    maxSubagentMessages?: number;
    maxSubagentDepth?: number;
}

interface ResolvedSerializeOptions {
    includeMessages: boolean;
    maxMessages: number;
    includeSubagents: boolean;
    maxSubagentMessages: number;
    maxSubagentDepth: number;
}

const MAX_GRAPH_SUBAGENT_DEPTH = 4;

// ---- SessionGraph class ----

export class SessionGraph {
    private readonly summary: SessionSummary;

    // Lazy caches
    private _messages?: GraphMessage[];
    private _toolUsage?: Map<string, ToolUsageEntry>;
    private _commands?: CommandEntry[];
    private _stats?: SessionStats;
    private _risks?: RiskFlag[];

    constructor(summary: SessionSummary) {
        this.summary = summary;
    }

    /** Session-level aggregate statistics */
    get stats(): SessionStats {
        if (!this._stats) {
            const s = this.summary;
            const totalCost = s.totalNanoAiu / 1_000_000_000;
            this._stats = {
                sessionId: s.sessionId,
                title: s.title,
                totalCostAic: totalCost,
                totalInputTokens: s.totalInputTokens,
                totalOutputTokens: s.totalOutputTokens,
                totalCachedTokens: s.totalCachedTokens,
                totalTokens: s.totalTokens,
                totalDurationMs: s.totalDurationMs,
                messageCount: s.userMessages.length,
                modelTurnCount: s.modelTurnCount,
                toolCallCount: s.toolCallCount,
                avgCostPerMessage: s.userMessages.length > 0 ? totalCost / s.userMessages.length : 0,
                avgTurnsPerMessage: s.userMessages.length > 0 ? s.modelTurnCount / s.userMessages.length : 0,
                cacheHitRatio: s.totalInputTokens > 0 ? s.totalCachedTokens / s.totalInputTokens : 0,
            };
        }
        return this._stats;
    }

    /** All messages with turns and tool calls (text capped at 100 words) */
    get messages(): GraphMessage[] {
        if (!this._messages) {
            this._messages = this.summary.userMessages.map((m, i) => this.buildGraphMessage(m, i));
        }
        return this._messages;
    }

    /** Get a specific message by index (0-based) */
    getMessage(index: number): GraphMessage | undefined {
        return this.messages[index];
    }

    /** Get messages in a range */
    getMessages(from: number, to: number): GraphMessage[] {
        return this.messages.slice(from, to);
    }

    /** Tool usage across the session, with tier classification */
    get toolUsage(): Map<string, ToolUsageEntry> {
        if (!this._toolUsage) {
            this._toolUsage = this.computeToolUsage();
        }
        return this._toolUsage;
    }

    /** Tools sorted by usage count (descending) */
    getToolsByUsage(): ToolUsageEntry[] {
        return [...this.toolUsage.values()].sort((a, b) => b.count - a.count);
    }

    /** Tools that were never used (wasted context) */
    getUnusedTools(): string[] {
        return [...this.toolUsage.values()]
            .filter(t => t.tier === 'never')
            .map(t => t.name);
    }

    /** Terminal commands grouped by executable */
    get commands(): CommandEntry[] {
        if (!this._commands) {
            this._commands = this.computeCommands();
        }
        return this._commands;
    }

    /** Identify risky operations */
    get risks(): RiskFlag[] {
        if (!this._risks) {
            this._risks = this.computeRisks();
        }
        return this._risks;
    }

    /** Prompt composition info (tool sizes, system prompt sizes) */
    get promptComposition(): PromptComposition | undefined {
        return this.summary.promptComposition;
    }

    /**
     * Serialize to a compact string for LLM context.
     * Produces a structured text summary suitable for injection into a chat prompt.
     */
    serialize(options?: SerializeOptions): string {
        const opts: ResolvedSerializeOptions = {
            includeMessages: options?.includeMessages ?? true,
            maxMessages: options?.maxMessages ?? 30,
            includeSubagents: options?.includeSubagents ?? true,
            maxSubagentMessages: options?.maxSubagentMessages ?? 10,
            maxSubagentDepth: options?.maxSubagentDepth ?? 3,
        };
        const lines: string[] = [];

        const s = this.stats;
        lines.push(`# Session: ${s.title || s.sessionId}`);
        lines.push(`Cost: ${s.totalCostAic.toFixed(2)} AIC | Tokens: ${formatNumber(s.totalTokens)} (in:${formatNumber(s.totalInputTokens)} out:${formatNumber(s.totalOutputTokens)} cache:${formatNumber(s.totalCachedTokens)})`);
        lines.push(`Messages: ${s.messageCount} | Turns: ${s.modelTurnCount} | Tool Calls: ${s.toolCallCount} | LLM Time: ${formatDuration(s.totalDurationMs)}`);
        lines.push(`Cache Hit: ${(s.cacheHitRatio * 100).toFixed(1)}% | Avg Cost/Message: ${s.avgCostPerMessage.toFixed(1)} AIC`);
        lines.push('');

        // Tool usage
        const tools = this.getToolsByUsage();
        const used = tools.filter(t => t.count > 0);
        const unused = tools.filter(t => t.count === 0);
        if (used.length > 0) {
            lines.push('## Tool Usage');
            for (const t of used) {
                lines.push(`  ${t.name}: ${t.count}x (${formatDuration(t.totalDurationMs)})`);
            }
            if (unused.length > 0) {
                lines.push(`  [${unused.length} tools available but never used]`);
            }
            lines.push('');
        }

        // Commands
        if (this.commands.length > 0) {
            lines.push('## Commands');
            for (const c of this.commands) {
                lines.push(`  ${c.executable}: ${c.count}x`);
            }
            lines.push('');
        }

        // Risks
        if (this.risks.length > 0) {
            lines.push('## Risk Flags');
            for (const r of this.risks) {
                lines.push(`  [${r.severity}] Message ${r.messageIndex + 1}, Turn ${r.turnIndex + 1}: ${r.reason} (${r.toolCall})`);
            }
            lines.push('');
        }

        // Messages
        if (opts.includeMessages) {
            lines.push('## Messages');
            const msgs = this.messages.slice(0, opts.maxMessages);
            for (const msg of msgs) {
                const cost = msg.costAic.toFixed(1);
                lines.push(`### ${msg.index + 1}: "${msg.content}" [${cost} AIC | ${msg.turnCount} turns | ${msg.toolCallCount} tool calls]`);
                for (const turn of msg.turns) {
                    lines.push(...this.serializeTurn(turn, '  ', opts, 0));
                }
            }
            if (this.messages.length > opts.maxMessages) {
                lines.push(`  ... ${this.messages.length - opts.maxMessages} more messages`);
            }
        }

        return lines.join('\n');
    }

    // ---- Private computation methods ----

    private serializeTurn(turn: GraphTurn, indent: string, opts: ResolvedSerializeOptions, subagentDepth: number): string[] {
        const lines: string[] = [];
        const tools = turn.toolCalls.map(tc => this.formatToolCallLabel(tc)).join(', ');
        lines.push(`${indent}Turn ${turn.index + 1}: ${turn.debugName} | ${turn.costAic.toFixed(1)} AIC | ${tools || 'response'}`);

        if (!opts.includeSubagents) {
            return lines;
        }

        for (const tc of turn.toolCalls) {
            lines.push(...this.serializeSubagent(tc, `${indent}  `, opts, subagentDepth + 1));
        }
        return lines;
    }

    private serializeSubagent(tc: GraphToolCall, indent: string, opts: ResolvedSerializeOptions, depth: number): string[] {
        if (!tc.subagent || depth > opts.maxSubagentDepth) {
            return [];
        }

        const sub = tc.subagent;
        const status = sub.inProgress ? 'in progress' : 'complete';
        const label = tc.displayLabel.replace(/^Subagent:\s*/i, '') || tc.displayLabel;
        const lines = [
            `${indent}Subagent: ${label} [${status} | ${sub.costAic.toFixed(2)} AIC | tokens in:${formatNumber(sub.inputTokens)} out:${formatNumber(sub.outputTokens)} cache:${formatNumber(sub.cachedTokens)} | ${sub.messageCount} messages | ${sub.modelTurnCount} turns | ${sub.toolCallCount} tool calls]`,
        ];

        const messages = sub.messages.slice(0, opts.maxSubagentMessages);
        for (const msg of messages) {
            lines.push(`${indent}  Message ${msg.index + 1}: "${msg.content}" [${msg.costAic.toFixed(1)} AIC | ${msg.turnCount} turns | ${msg.toolCallCount} tool calls]`);
            for (const turn of msg.turns) {
                lines.push(...this.serializeTurn(turn, `${indent}    `, opts, depth));
            }
        }

        if (sub.messages.length > opts.maxSubagentMessages) {
            lines.push(`${indent}  ... ${sub.messages.length - opts.maxSubagentMessages} more subagent messages`);
        }
        return lines;
    }

    private formatToolCallLabel(tc: GraphToolCall): string {
        let label = tc.toolKind ? `${tc.displayLabel} [${tc.toolKind}]` : tc.displayLabel;
        if (tc.subagentInProgress) {
            label += ' [in progress]';
        } else if (tc.isSubagent && tc.subagentCostAic !== undefined) {
            label += ` (${tc.subagentCostAic.toFixed(1)} AIC)`;
        }
        return label;
    }

    private buildGraphMessage(m: UserMessageSummary, index: number, subagentDepth = 0): GraphMessage {
        return {
            index,
            content: capWords(m.content, 100),
            timestamp: m.timestamp,
            costAic: m.totalNanoAiu / 1_000_000_000,
            inputTokens: m.totalInputTokens,
            outputTokens: m.totalOutputTokens,
            cachedTokens: m.totalCachedTokens,
            totalTokens: m.totalTokens,
            durationMs: m.totalDurationMs,
            turnCount: m.modelTurns.length,
            toolCallCount: m.toolCalls.length,
            continuations: m.mergedMessages.length,
            turns: m.modelTurns.map((t, i) => this.buildGraphTurn(t, i, subagentDepth)),
        };
    }

    private buildGraphTurn(t: ModelTurnSummary, index: number, subagentDepth = 0): GraphTurn {
        return {
            index,
            model: t.model,
            debugName: t.debugName,
            costAic: t.nanoAiu / 1_000_000_000,
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            cachedTokens: t.cachedTokens,
            freshTokens: t.freshTokens,
            cacheHitRatio: t.cacheHitRatio,
            durationMs: t.durationMs,
            ttftMs: t.ttftMs,
            toolCalls: t.toolCalls.map(tc => this.buildGraphToolCall(tc, subagentDepth)),
        };
    }

    private buildGraphToolCall(tc: ToolCallSummary, subagentDepth: number): GraphToolCall {
        const call: GraphToolCall = {
            name: tc.name,
            displayLabel: tc.displayLabel.slice(0, 80),
            durationMs: tc.durationMs,
            isSubagent: tc.isSubagent,
            source: tc.source,
            toolKind: tc.toolKind,
            resultCount: tc.resultCount,
            subagentCostAic: tc.subagentSummary ? tc.subagentSummary.totalNanoAiu / 1_000_000_000 : undefined,
            subagentInProgress: tc.subagentInProgress || false,
        };

        if (tc.subagentSummary && subagentDepth < MAX_GRAPH_SUBAGENT_DEPTH) {
            call.subagent = this.buildGraphSubagent(tc.subagentSummary, subagentDepth + 1);
        }

        return call;
    }

    private buildGraphSubagent(summary: SessionSummary, subagentDepth: number): GraphSubagent {
        return {
            sessionId: summary.sessionId,
            title: summary.title,
            inProgress: summary.inProgress || false,
            costAic: summary.totalNanoAiu / 1_000_000_000,
            inputTokens: summary.totalInputTokens,
            outputTokens: summary.totalOutputTokens,
            cachedTokens: summary.totalCachedTokens,
            totalTokens: summary.totalTokens,
            durationMs: summary.totalDurationMs,
            messageCount: summary.userMessages.length,
            modelTurnCount: summary.modelTurnCount,
            toolCallCount: summary.toolCallCount,
            messages: summary.userMessages.map((m, i) => this.buildGraphMessage(m, i, subagentDepth)),
        };
    }

    private computeToolUsage(): Map<string, ToolUsageEntry> {
        const counts = new Map<string, { count: number; totalDurationMs: number }>();

        for (const msg of this.summary.userMessages) {
            for (const turn of msg.modelTurns) {
                for (const tc of turn.toolCalls) {
                    const existing = counts.get(tc.name);
                    if (existing) {
                        existing.count++;
                        existing.totalDurationMs += tc.durationMs;
                    } else {
                        counts.set(tc.name, { count: 1, totalDurationMs: tc.durationMs });
                    }
                }
            }
        }

        // Add tools from prompt composition that were never used
        if (this.summary.promptComposition) {
            for (const defs of Object.values(this.summary.promptComposition.toolSets)) {
                for (const def of defs) {
                    if (!counts.has(def.name)) {
                        counts.set(def.name, { count: 0, totalDurationMs: 0 });
                    }
                }
            }
        }

        const result = new Map<string, ToolUsageEntry>();
        for (const [name, data] of counts) {
            const tier: ToolUsageEntry['tier'] =
                data.count === 0 ? 'never' :
                data.count <= 2 ? 'light' :
                data.count <= 5 ? 'medium' : 'heavy';
            result.set(name, { name, count: data.count, totalDurationMs: data.totalDurationMs, tier });
        }
        return result;
    }

    private computeCommands(): CommandEntry[] {
        const counts = new Map<string, number>();

        for (const msg of this.summary.userMessages) {
            for (const turn of msg.modelTurns) {
                for (const tc of turn.toolCalls) {
                    if (tc.name === 'run_in_terminal') {
                        const exe = extractExe(tc.displayLabel);
                        if (exe) {
                            counts.set(exe, (counts.get(exe) || 0) + 1);
                        }
                    }
                }
            }
        }

        return [...counts.entries()]
            .map(([executable, count]) => ({ executable, count }))
            .sort((a, b) => b.count - a.count);
    }

    private computeRisks(): RiskFlag[] {
        const risks: RiskFlag[] = [];
        const riskyPatterns: { pattern: RegExp; reason: string; severity: RiskFlag['severity'] }[] = [
            { pattern: /--force|--hard|--no-verify/i, reason: 'Force/unsafe flag used', severity: 'high' },
            { pattern: /rm\s+-rf|Remove-Item.*-Recurse/i, reason: 'Recursive delete', severity: 'high' },
            { pattern: /drop\s+table|drop\s+database/i, reason: 'Database drop command', severity: 'high' },
            { pattern: /git\s+push/i, reason: 'Git push (publishes code)', severity: 'medium' },
            { pattern: /git\s+reset/i, reason: 'Git reset (may lose work)', severity: 'medium' },
            { pattern: /npm\s+publish|npx\s+publish/i, reason: 'Package publish', severity: 'medium' },
            { pattern: /curl|wget|Invoke-WebRequest/i, reason: 'Network request', severity: 'low' },
        ];

        for (const msg of this.messages) {
            for (const turn of msg.turns) {
                for (const tc of turn.toolCalls) {
                    if (tc.name === 'run_in_terminal') {
                        for (const { pattern, reason, severity } of riskyPatterns) {
                            if (pattern.test(tc.displayLabel)) {
                                risks.push({
                                    messageIndex: msg.index,
                                    turnIndex: turn.index,
                                    toolCall: tc.displayLabel,
                                    reason,
                                    severity,
                                });
                            }
                        }
                    }
                }
            }
        }
        return risks;
    }
}

// ---- Comparison ----

export function compareGraphs(a: SessionGraph, b: SessionGraph): GraphComparison {
    const sa = a.stats;
    const sb = b.stats;

    // Tool usage diff
    const allTools = new Set([...a.toolUsage.keys(), ...b.toolUsage.keys()]);
    const toolUsageDiff: GraphComparison['toolUsageDiff'] = [];
    for (const name of allTools) {
        const countA = a.toolUsage.get(name)?.count ?? 0;
        const countB = b.toolUsage.get(name)?.count ?? 0;
        if (countA !== countB) {
            toolUsageDiff.push({ name, countA, countB });
        }
    }
    toolUsageDiff.sort((a, b) => Math.abs(b.countB - b.countA) - Math.abs(a.countB - a.countA));

    // Command diff
    const cmdMapA = new Map(a.commands.map(c => [c.executable, c.count]));
    const cmdMapB = new Map(b.commands.map(c => [c.executable, c.count]));
    const allCmds = new Set([...cmdMapA.keys(), ...cmdMapB.keys()]);
    const commandDiff: GraphComparison['commandDiff'] = [];
    for (const exe of allCmds) {
        const cA = cmdMapA.get(exe) ?? 0;
        const cB = cmdMapB.get(exe) ?? 0;
        if (cA !== cB) {
            commandDiff.push({ executable: exe, countA: cA, countB: cB });
        }
    }

    return {
        sessionA: sa,
        sessionB: sb,
        costDelta: sb.totalCostAic - sa.totalCostAic,
        tokenDelta: sb.totalTokens - sa.totalTokens,
        turnDelta: sb.modelTurnCount - sa.modelTurnCount,
        toolUsageDiff,
        commandDiff,
    };
}

/** Serialize a comparison for LLM context */
export function serializeComparison(cmp: GraphComparison): string {
    const lines: string[] = [];
    lines.push(`# Session Comparison`);
    lines.push(`## Session A: ${cmp.sessionA.title || cmp.sessionA.sessionId}`);
    lines.push(`  Cost: ${cmp.sessionA.totalCostAic.toFixed(2)} AIC | Messages: ${cmp.sessionA.messageCount} | Turns: ${cmp.sessionA.modelTurnCount}`);
    lines.push(`## Session B: ${cmp.sessionB.title || cmp.sessionB.sessionId}`);
    lines.push(`  Cost: ${cmp.sessionB.totalCostAic.toFixed(2)} AIC | Messages: ${cmp.sessionB.messageCount} | Turns: ${cmp.sessionB.modelTurnCount}`);
    lines.push('');
    lines.push(`## Deltas`);
    lines.push(`  Cost: ${cmp.costDelta >= 0 ? '+' : ''}${cmp.costDelta.toFixed(2)} AIC`);
    lines.push(`  Tokens: ${cmp.tokenDelta >= 0 ? '+' : ''}${formatNumber(cmp.tokenDelta)}`);
    lines.push(`  Turns: ${cmp.turnDelta >= 0 ? '+' : ''}${cmp.turnDelta}`);

    if (cmp.toolUsageDiff.length > 0) {
        lines.push('');
        lines.push('## Tool Usage Differences');
        for (const d of cmp.toolUsageDiff.slice(0, 15)) {
            lines.push(`  ${d.name}: A=${d.countA} B=${d.countB} (${d.countB - d.countA >= 0 ? '+' : ''}${d.countB - d.countA})`);
        }
    }

    if (cmp.commandDiff.length > 0) {
        lines.push('');
        lines.push('## Command Differences');
        for (const d of cmp.commandDiff) {
            lines.push(`  ${d.executable}: A=${d.countA} B=${d.countB}`);
        }
    }

    return lines.join('\n');
}

// ---- Utilities ----

/** Cap text at N words */
function capWords(text: string, maxWords: number): string {
    const words = text.split(/\s+/);
    if (words.length <= maxWords) { return text; }
    return words.slice(0, maxWords).join(' ') + '…';
}

/** Extract executable from a "Ran: ..." display label */
function extractExe(displayLabel: string): string | undefined {
    const match = displayLabel.match(/^Ran:\s*(?:cd\s+[^;]+;\s*)?(.+)/);
    if (!match) { return undefined; }
    let cmd = match[1].trim();
    const assignMatch = cmd.match(/^\$\w+\s*=\s*(.+)/);
    if (assignMatch) { cmd = assignMatch[1].trim(); }
    const exe = cmd.split(/\s+/)[0].replace(/['"]/g, '');
    if (exe.startsWith('$') || exe.startsWith('(') || exe.startsWith('{') || exe === '') { return undefined; }
    return exe;
}
