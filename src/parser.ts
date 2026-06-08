import * as fs from 'fs';
import * as path from 'path';

export const NANO_AIU_PER_AIC = 1_000_000_000;
const IN_PROGRESS_SUBAGENT_STALE_MS = 5 * 60 * 1000;

export interface LlmRequestAttrs {
    model?: string;
    debugName?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    ttft?: number;
    copilotUsageNanoAiu?: number;
    responseId?: string;
    systemPromptFile?: string;
    toolsFile?: string;
    inputMessages?: string;
}

export interface ToolCallAttrs {
    args?: string;
    result?: string;
    displayLabel?: string;
    source?: string;
    toolKind?: string;
    resultCount?: number;
    toolCallId?: string;
}

export interface UserMessageAttrs {
    content?: string;
}

export interface LogEntry {
    v?: number;
    ts: number;
    dur: number;
    sid: string;
    type: string;
    name: string;
    spanId: string;
    parentSpanId?: string;
    status: string;
    attrs: LlmRequestAttrs & ToolCallAttrs & UserMessageAttrs & {
        turnId?: string;
        childLogFile?: string;
        childSessionId?: string;
        label?: string;
        systemPromptFile?: string;
        toolsFile?: string;
        inputMessages?: string;
    };
}

export interface ToolCallSummary {
    name: string;
    displayLabel: string; // e.g. "Ran: git clone...", "Search: chat debug"
    durationMs: number;
    timestamp: number;
    spanId?: string;
    isSubagent: boolean;
    source?: string;
    toolKind?: string;
    resultCount?: number;
    toolCallId?: string;
    subagentSummary?: SessionSummary; // populated if subagent log is parsed
    subagentInProgress?: boolean;
}

export interface ModelTurnSummary {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    nanoAiu: number;
    durationMs: number;
    ttftMs: number;
    timestamp: number;
    debugName: string;
    toolCalls: ToolCallSummary[];
    cacheHitRatio: number; // cachedTokens / inputTokens (0-1)
    freshTokens: number;   // inputTokens - cachedTokens
    systemPromptFile?: string;
    toolsFile?: string;
    inputMessagesChars: number;
}

export interface MergedMessageInfo {
    content: string;
    timestamp: number;
    spanId: string;
}

export interface UserMessageSummary {
    spanId: string;
    content: string;
    timestamp: number;
    modelTurns: ModelTurnSummary[];
    toolCalls: ToolCallSummary[];
    mergedMessages: MergedMessageInfo[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalTokens: number;
    totalNanoAiu: number;
    totalDurationMs: number;
    /** Context size at start of this message (first turn's inputMessages chars) */
    contextCharsAtStart: number;
    systemPromptFile?: string;
    toolsFile?: string;
}

export interface SessionSummary {
    sessionId: string;
    title?: string;
    sourceType?: 'debugLog' | 'chatSession';
    inProgress?: boolean;
    userMessages: UserMessageSummary[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalTokens: number;
    totalNanoAiu: number;
    totalDurationMs: number;
    modelTurnCount: number;
    toolCallCount: number;
    promptComposition?: PromptComposition;
}

export interface ParsedSessionFile {
    summary: SessionSummary;
    sourceFile: string;
    sourceType: 'debugLog' | 'chatSession';
}

export interface ToolDefinitionSize {
    name: string;
    chars: number;
    estimatedTokens: number;
}

export interface PromptComposition {
    /** All distinct tool definition sets used in the session, keyed by filename */
    toolSets: { [filename: string]: ToolDefinitionSize[] };
    /** All distinct system prompt sizes, keyed by filename */
    systemPrompts: { [filename: string]: { chars: number; estimatedTokens: number } };
}

/** Generate a human-friendly display label for a tool call based on its args */
function getToolDisplayLabel(name: string, argsStr: string | undefined, fallbackLabel?: string): string {
    if (!argsStr) { return fallbackLabel || name; }

    try {
        const args = JSON.parse(argsStr);
        switch (name) {
            case 'run_in_terminal': {
                const cmd = args.command || '';
                const short = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
                return `Ran: ${short}`;
            }
            case 'grep_search': {
                const q = args.query || '';
                const pat = args.includePattern ? ` in ${path.basename(args.includePattern)}` : '';
                return `Search: "${q}"${pat}`;
            }
            case 'read_file': {
                const fp = args.filePath || '';
                const fname = path.basename(fp);
                const lines = args.startLine && args.endLine ? ` L${args.startLine}-${args.endLine}` : '';
                return `Read: ${fname}${lines}`;
            }
            case 'file_search': {
                return `Find files: ${args.query || ''}`;
            }
            case 'replace_string_in_file':
            case 'multi_replace_string_in_file': {
                const fp = args.filePath || (args.replacements?.[0]?.filePath) || '';
                return `Edit: ${path.basename(fp)}`;
            }
            case 'create_file': {
                const fp = args.filePath || '';
                return `Create: ${path.basename(fp)}`;
            }
            case 'list_dir': {
                const p = args.path || '';
                return `List: ${path.basename(p) || p}`;
            }
            case 'runSubagent': {
                const desc = args.description || args.agentName || 'subagent';
                return `Subagent: ${desc}`;
            }
            case 'manage_todo_list':
                return 'Update todo list';
            case 'semantic_search':
                return `Semantic search: "${(args.query || '').slice(0, 40)}"`;
            case 'tool_search':
                return `Tool search: "${(args.query || '').slice(0, 40)}"`;
            case 'get_terminal_output':
                return 'Get terminal output';
            case 'kill_terminal':
                return 'Kill terminal';
            case 'send_to_terminal':
                return `Send to terminal: "${(args.command || '').slice(0, 40)}"`;
            case 'vscode_askQuestions':
                return 'Ask user questions';
            default:
                return fallbackLabel || name;
        }
    } catch {
        return fallbackLabel || name;
    }
}

/** Patterns that indicate a system-generated continuation, not a real user message */
export function isSystemContinuation(content: string): boolean {
    return content.startsWith('[Terminal') ||
           content.startsWith('[Notification') ||
           content.startsWith('[Background terminal');
}

function firstDefined<T>(...values: T[]): T | undefined {
    return values.find(value => value !== undefined && value !== null);
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}

function toTimestamp(value: unknown, fallback: number): number {
    const numeric = toNumber(value);
    if (numeric !== undefined) {
        return numeric;
    }

    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return fallback;
}

function asString(value: unknown, fallback = ''): string {
    if (value === undefined || value === null) {
        return fallback;
    }

    return String(value);
}

function stringifyValue(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeEntryType(type: unknown): string {
    switch (asString(type).toLowerCase()) {
        case 'model_response':
        case 'model_turn':
        case 'assistant_message':
            return 'llm_request';
        case 'toolcall':
            return 'tool_call';
        default:
            return asString(type);
    }
}

function normalizeEntry(raw: any, index: number): LogEntry | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }

    const rawAttrs = raw.attrs && typeof raw.attrs === 'object' ? raw.attrs : {};
    const type = normalizeEntryType(firstDefined(raw.type, rawAttrs.type));
    if (!type) {
        return undefined;
    }

    const ts = toTimestamp(firstDefined(raw.ts, raw.timestamp, raw.time, rawAttrs.ts, rawAttrs.timestamp), index);
    const sessionId = asString(firstDefined(raw.sid, raw.sessionId, raw.session_id, rawAttrs.sid, rawAttrs.sessionId), 'unknown');
    const name = asString(firstDefined(raw.name, raw.toolName, raw.tool_name, raw.debugName, rawAttrs.name, rawAttrs.toolName, rawAttrs.debugName), type);
    const spanId = asString(firstDefined(raw.spanId, raw.spanID, raw.id, rawAttrs.spanId), `${type}-${index}`);

    return {
        v: raw.v,
        ts,
        dur: toNumber(firstDefined(raw.dur, raw.durationMs, raw.duration_ms, rawAttrs.dur, rawAttrs.durationMs)) || 0,
        sid: sessionId,
        type,
        name,
        spanId,
        parentSpanId: asString(firstDefined(raw.parentSpanId, raw.parentSpanID, rawAttrs.parentSpanId), undefined as any),
        status: asString(firstDefined(raw.status, rawAttrs.status), 'ok'),
        attrs: {
            ...rawAttrs,
            turnId: firstDefined(rawAttrs.turnId, raw.turnId),
            childLogFile: firstDefined(rawAttrs.childLogFile, raw.childLogFile),
            childSessionId: firstDefined(rawAttrs.childSessionId, raw.childSessionId),
            label: firstDefined(rawAttrs.label, raw.label),
            content: firstDefined(rawAttrs.content, raw.content, raw.message, raw.prompt),
            model: firstDefined(rawAttrs.model, raw.model),
            debugName: firstDefined(rawAttrs.debugName, raw.debugName, raw.name),
            inputTokens: toNumber(firstDefined(rawAttrs.inputTokens, rawAttrs.prompt_tokens, rawAttrs.promptTokens, raw.inputTokens, raw.prompt_tokens, raw.promptTokens)),
            outputTokens: toNumber(firstDefined(rawAttrs.outputTokens, rawAttrs.completion_tokens, rawAttrs.completionTokens, raw.outputTokens, raw.completion_tokens, raw.completionTokens)),
            cachedTokens: toNumber(firstDefined(rawAttrs.cachedTokens, rawAttrs.cached_tokens, raw.cachedTokens, raw.cached_tokens)),
            ttft: toNumber(firstDefined(rawAttrs.ttft, rawAttrs.ttftMs, raw.ttft, raw.ttftMs)),
            copilotUsageNanoAiu: toNumber(firstDefined(rawAttrs.copilotUsageNanoAiu, rawAttrs.nanoAiu, rawAttrs.nanoAiU, raw.copilotUsageNanoAiu, raw.nanoAiu, raw.nanoAiU)),
            responseId: firstDefined(rawAttrs.responseId, raw.responseId),
            systemPromptFile: firstDefined(rawAttrs.systemPromptFile, raw.systemPromptFile),
            toolsFile: firstDefined(rawAttrs.toolsFile, raw.toolsFile),
            inputMessages: firstDefined(rawAttrs.inputMessages, raw.inputMessages),
            args: stringifyValue(firstDefined(rawAttrs.args, raw.args)),
            result: stringifyValue(firstDefined(rawAttrs.result, raw.result)),
            displayLabel: firstDefined(rawAttrs.displayLabel, raw.displayLabel),
            source: firstDefined(rawAttrs.source, raw.source),
            toolKind: firstDefined(rawAttrs.toolKind, raw.toolKind),
            resultCount: toNumber(firstDefined(rawAttrs.resultCount, raw.resultCount)),
            toolCallId: firstDefined(rawAttrs.toolCallId, raw.toolCallId),
        },
    };
}

function normalizeParsedEntries(raw: any, index: number): LogEntry[] {
    const entry = normalizeEntry(raw, index);
    if (!entry) {
        return [];
    }

    const entries = [entry];
    const inlineTools = firstDefined(raw.toolCalls, raw.tools, raw.attrs?.toolCalls);
    if (entry.type !== 'llm_request' || !Array.isArray(inlineTools)) {
        return entries;
    }

    inlineTools.forEach((tool: any, toolIndex: number) => {
        const toolName = asString(firstDefined(tool.name, tool.toolName, tool.tool_name), 'tool_call');
        const displayLabel = asString(firstDefined(tool.displayLabel, tool.label, tool.command, toolName), toolName);
        const args = firstDefined(
            tool.args,
            tool.arguments,
            toolName === 'run_in_terminal' ? { command: displayLabel } : undefined
        );

        entries.push({
            ts: entry.ts + toolIndex + 1,
            dur: toNumber(firstDefined(tool.durationMs, tool.duration, tool.dur)) || 0,
            sid: entry.sid,
            type: 'tool_call',
            name: toolName,
            spanId: asString(firstDefined(tool.spanId, tool.id), `${entry.spanId}-tool-${toolIndex}`),
            parentSpanId: entry.spanId,
            status: asString(firstDefined(tool.status), 'ok'),
            attrs: {
                args: stringifyValue(args),
                result: stringifyValue(firstDefined(tool.result, tool.output)),
                displayLabel,
                source: firstDefined(tool.source?.label, tool.source),
                toolKind: firstDefined(tool.toolKind, tool.kind),
                resultCount: toNumber(firstDefined(tool.resultCount, tool.resultDetails?.length)),
                toolCallId: firstDefined(tool.toolCallId, tool.id),
            },
        });
    });

    return entries;
}

/** Parse an array of log entries into a SessionSummary. Separated from file I/O for testability. */
export function parseEntries(entries: LogEntry[]): SessionSummary | undefined {
    if (entries.length === 0) {
        return undefined;
    }

    const sessionId = entries[0].sid;

    const userMessages = entries.filter(e => e.type === 'user_message');
    const llmRequests = entries.filter(e => e.type === 'llm_request');
    const toolCalls = entries.filter(e => e.type === 'tool_call');

    // Build raw message groups (before merging)
    interface RawGroup {
        msg: LogEntry;
        llmRequests: LogEntry[];
        toolCalls: LogEntry[];
    }

    const rawGroups: RawGroup[] = [];
    for (let i = 0; i < userMessages.length; i++) {
        const msg = userMessages[i];
        const nextMsg = userMessages[i + 1];

        // Group by timestamp boundaries only. SpanIds get recycled across messages
        // so parentSpanId matching is unreliable.
        const msgLlmRequests = llmRequests.filter(r =>
            r.ts >= msg.ts && (nextMsg ? r.ts < nextMsg.ts : true)
        );

        const msgToolCalls = toolCalls.filter(t =>
            t.ts >= msg.ts && (nextMsg ? t.ts < nextMsg.ts : true)
        );

        rawGroups.push({ msg, llmRequests: msgLlmRequests, toolCalls: msgToolCalls });
    }

    // Merge system continuations (e.g. "[Terminal ...") into the previous real user message
    interface MergedGroup {
        primaryMsg: LogEntry;
        allLlmRequests: LogEntry[];
        allToolCalls: LogEntry[];
        mergedMessages: MergedMessageInfo[];
    }

    const mergedGroups: MergedGroup[] = [];
    for (let i = 0; i < rawGroups.length; i++) {
        const group = rawGroups[i];
        const msgContent = group.msg.attrs.content || '';

        if (i > 0 && isSystemContinuation(msgContent) && mergedGroups.length > 0) {
            const prev = mergedGroups[mergedGroups.length - 1];
            prev.allLlmRequests.push(...group.llmRequests);
            prev.allToolCalls.push(...group.toolCalls);
            prev.mergedMessages.push({
                content: msgContent.slice(0, 80).replace(/[\r\n]+/g, ' '),
                timestamp: group.msg.ts,
                spanId: group.msg.spanId,
            });
        } else {
            mergedGroups.push({
                primaryMsg: group.msg,
                allLlmRequests: [...group.llmRequests],
                allToolCalls: [...group.toolCalls],
                mergedMessages: [],
            });
        }
    }

    // Build summaries with tool calls assigned to specific turns
    const messageSummaries: UserMessageSummary[] = [];

    for (const group of mergedGroups) {
        group.allLlmRequests.sort((a, b) => a.ts - b.ts);
        group.allToolCalls.sort((a, b) => a.ts - b.ts);

        const modelTurns: ModelTurnSummary[] = [];
        for (let j = 0; j < group.allLlmRequests.length; j++) {
            const r = group.allLlmRequests[j];
            const nextR = group.allLlmRequests[j + 1];

            const turnToolCalls = group.allToolCalls.filter(t =>
                t.ts >= r.ts && (nextR ? t.ts < nextR.ts : true)
            );
            const preTools = j === 0
                ? group.allToolCalls.filter(t => t.ts < r.ts)
                : [];

            const allTurnTools = [...preTools, ...turnToolCalls];

            const inputTk = r.attrs.inputTokens || 0;
            const cachedTk = r.attrs.cachedTokens || 0;

            modelTurns.push({
                model: r.attrs.model || 'unknown',
                inputTokens: inputTk,
                outputTokens: r.attrs.outputTokens || 0,
                cachedTokens: cachedTk,
                totalTokens: inputTk + (r.attrs.outputTokens || 0),
                nanoAiu: r.attrs.copilotUsageNanoAiu || 0,
                durationMs: r.dur,
                ttftMs: r.attrs.ttft || 0,
                timestamp: r.ts,
                debugName: r.attrs.debugName || r.name || '',
                cacheHitRatio: inputTk > 0 ? cachedTk / inputTk : 0,
                freshTokens: inputTk - cachedTk,
                systemPromptFile: r.attrs.systemPromptFile,
                toolsFile: r.attrs.toolsFile,
                inputMessagesChars: (r.attrs.inputMessages || '').length,
                toolCalls: allTurnTools.map(t => ({
                    name: t.name,
                    displayLabel: getToolDisplayLabel(t.name, t.attrs.args, t.attrs.displayLabel),
                    durationMs: t.dur,
                    timestamp: t.ts,
                    spanId: t.spanId,
                    isSubagent: t.name === 'runSubagent',
                    source: t.attrs.source,
                    toolKind: t.attrs.toolKind,
                    resultCount: t.attrs.resultCount,
                    toolCallId: t.attrs.toolCallId,
                })),
            });
        }

        const allToolCallSummaries: ToolCallSummary[] = group.allToolCalls.map(t => ({
            name: t.name,
            displayLabel: getToolDisplayLabel(t.name, t.attrs.args, t.attrs.displayLabel),
            durationMs: t.dur,
            timestamp: t.ts,
            spanId: t.spanId,
            isSubagent: t.name === 'runSubagent',
            source: t.attrs.source,
            toolKind: t.attrs.toolKind,
            resultCount: t.attrs.resultCount,
            toolCallId: t.attrs.toolCallId,
        }));

        const totalInput = modelTurns.reduce((s, t) => s + t.inputTokens, 0);
        const totalOutput = modelTurns.reduce((s, t) => s + t.outputTokens, 0);
        const totalCached = modelTurns.reduce((s, t) => s + t.cachedTokens, 0);
        const totalTokens = modelTurns.reduce((s, t) => s + t.totalTokens, 0);
        const totalNano = modelTurns.reduce((s, t) => s + t.nanoAiu, 0);
        const totalDur = modelTurns.reduce((s, t) => s + t.durationMs, 0);

        const contentPreview = (group.primaryMsg.attrs.content || '').slice(0, 80).replace(/[\r\n]+/g, ' ');

        const firstTurn = modelTurns[0];
        messageSummaries.push({
            spanId: group.primaryMsg.spanId,
            content: contentPreview,
            timestamp: group.primaryMsg.ts,
            modelTurns,
            toolCalls: allToolCallSummaries,
            mergedMessages: group.mergedMessages,
            totalInputTokens: totalInput,
            totalOutputTokens: totalOutput,
            totalCachedTokens: totalCached,
            totalTokens,
            totalNanoAiu: totalNano,
            totalDurationMs: totalDur,
            contextCharsAtStart: firstTurn ? firstTurn.inputMessagesChars : 0,
            systemPromptFile: firstTurn?.systemPromptFile,
            toolsFile: firstTurn?.toolsFile,
        });
    }

    const totalInput = messageSummaries.reduce((s, m) => s + m.totalInputTokens, 0);
    const totalOutput = messageSummaries.reduce((s, m) => s + m.totalOutputTokens, 0);
    const totalCached = messageSummaries.reduce((s, m) => s + m.totalCachedTokens, 0);
    const totalTokens = messageSummaries.reduce((s, m) => s + m.totalTokens, 0);
    const totalNano = messageSummaries.reduce((s, m) => s + m.totalNanoAiu, 0);
    const totalDur = messageSummaries.reduce((s, m) => s + m.totalDurationMs, 0);
    const modelTurnCount = messageSummaries.reduce((s, m) => s + m.modelTurns.length, 0);
    const toolCallCount = messageSummaries.reduce((s, m) => s + m.toolCalls.length, 0);

    return {
        sessionId,
        userMessages: messageSummaries,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCachedTokens: totalCached,
        totalTokens,
        totalNanoAiu: totalNano,
        totalDurationMs: totalDur,
        modelTurnCount,
        toolCallCount,
    };
}

/** Quick-peek: check if a JSONL file contains billing data in first 4KB */
export function quickPeekHasBillingData(filePath: string): boolean {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const sample = buf.toString('utf-8', 0, bytesRead);
        return sample.includes('copilotUsageNanoAiu') ||
            sample.includes('nanoAiu') ||
            sample.includes('nanoAiU');
    } catch {
        return false;
    }
}

function setNestedValue(target: any, pathParts: unknown[], value: unknown): void {
    if (!target || !Array.isArray(pathParts) || pathParts.length === 0) {
        return;
    }

    let cursor = target;
    for (let i = 0; i < pathParts.length - 1; i++) {
        const key = pathParts[i] as string | number;
        const nextKey = pathParts[i + 1];

        if (cursor[key] === undefined || cursor[key] === null) {
            cursor[key] = typeof nextKey === 'number' ? [] : {};
        }

        cursor = cursor[key];
    }

    cursor[pathParts[pathParts.length - 1] as string | number] = value;
}

function deleteNestedValue(target: any, pathParts: unknown[]): void {
    if (!target || !Array.isArray(pathParts) || pathParts.length === 0) {
        return;
    }

    let cursor = target;
    for (let i = 0; i < pathParts.length - 1; i++) {
        cursor = cursor?.[pathParts[i] as string | number];
        if (cursor === undefined || cursor === null) {
            return;
        }
    }

    delete cursor[pathParts[pathParts.length - 1] as string | number];
}

function pushNestedArray(target: any, pathParts: unknown[], values: unknown, startIndex: unknown): void {
    if (!target || !Array.isArray(pathParts) || pathParts.length === 0) {
        return;
    }

    let cursor = target;
    for (let i = 0; i < pathParts.length - 1; i++) {
        const key = pathParts[i] as string | number;
        if (cursor[key] === undefined || cursor[key] === null) {
            cursor[key] = typeof pathParts[i + 1] === 'number' ? [] : {};
        }
        cursor = cursor[key];
    }

    const arrayKey = pathParts[pathParts.length - 1] as string | number;
    const arr = Array.isArray(cursor[arrayKey]) ? cursor[arrayKey] : [];
    const numericStart = toNumber(startIndex);

    if (numericStart !== undefined) {
        arr.length = numericStart;
    }

    if (Array.isArray(values) && values.length > 0) {
        arr.push(...values);
    }

    cursor[arrayKey] = arr;
}

function extractChatText(value: any): string {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(part => extractChatText(part)).filter(Boolean).join('');
    }

    if (typeof value !== 'object') {
        return '';
    }

    if (typeof value.text === 'string') {
        return value.text;
    }

    if (typeof value.value === 'string') {
        return value.value;
    }

    if (typeof value.content === 'string') {
        return value.content;
    }

    if (Array.isArray(value.parts)) {
        return extractChatText(value.parts);
    }

    return '';
}

function extractMarkdownValue(value: any): string | undefined {
    if (!value) {
        return undefined;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value.value === 'string') {
        return value.value;
    }

    if (typeof value.markdown === 'string') {
        return value.markdown;
    }

    return undefined;
}

function normalizeChatToolName(part: any): string {
    const raw = asString(firstDefined(part.toolId, part.source?.label, part.kind), 'tool_call');
    return raw.replace(/^copilot[_-]/i, '') || 'tool_call';
}

function getChatToolDisplayLabel(part: any): string {
    return asString(
        firstDefined(
            extractMarkdownValue(part.pastTenseMessage),
            extractMarkdownValue(part.invocationMessage),
            extractMarkdownValue(part.presentation),
            part.toolId,
            part.source?.label
        ),
        normalizeChatToolName(part)
    ).replace(/[\r\n]+/g, ' ').trim();
}

function getChatToolSource(part: any): string | undefined {
    return asString(firstDefined(part.source?.label, part.source?.type), undefined as any);
}

function getChatToolKind(part: any): string | undefined {
    const explicitKind = asString(part.toolSpecificData?.kind, '');
    if (explicitKind) {
        return explicitKind;
    }

    const normalizedName = normalizeChatToolName(part).toLowerCase();
    if (normalizedName.includes('terminal')) {
        return 'terminal';
    }
    if (normalizedName.includes('find') || normalizedName.includes('search')) {
        return 'search';
    }
    if (normalizedName.includes('replace') || normalizedName.includes('edit')) {
        return 'edit';
    }
    if (normalizedName.includes('error') || normalizedName.includes('diagnostic')) {
        return 'diagnostics';
    }
    if (normalizedName.includes('todo')) {
        return 'todo';
    }

    return undefined;
}

function getChatToolResultCount(part: any): number | undefined {
    if (Array.isArray(part.resultDetails)) {
        return part.resultDetails.length;
    }
    if (Array.isArray(part.resultDetails?.output)) {
        return part.resultDetails.output.length;
    }
    if (Array.isArray(part.toolSpecificData?.todoList)) {
        return part.toolSpecificData.todoList.length;
    }
    return undefined;
}

function getChatRequestDurationMs(request: any, timestamp: number): number {
    const direct = toNumber(firstDefined(
        request.elapsedMs,
        request.durationMs,
        request.timeSpentWaiting,
        request.result?.timings?.elapsedMs,
        request.result?.timings?.durationMs,
        request.result?.timings?.totalElapsedMs
    ));

    if (direct !== undefined) {
        return direct;
    }

    const completedAt = toNumber(request.modelState?.completedAt);
    return completedAt !== undefined && completedAt >= timestamp ? completedAt - timestamp : 0;
}

function getChatRequestOutputTokens(request: any): number {
    return toNumber(firstDefined(
        request.completionTokens,
        request.outputTokens,
        request.completion_tokens,
        request.output_tokens,
        request.result?.metadata?.completionTokens,
        request.result?.metadata?.outputTokens,
        request.result?.metadata?.completion_tokens,
        request.result?.metadata?.output_tokens,
        request.result?.metadata?.usage?.completionTokens,
        request.result?.metadata?.usage?.outputTokens,
        request.result?.metadata?.usage?.completion_tokens,
        request.result?.metadata?.usage?.output_tokens
    )) || 0;
}

function getChatRequestInputTokens(request: any): number {
    return toNumber(firstDefined(
        request.promptTokens,
        request.inputTokens,
        request.prompt_tokens,
        request.input_tokens,
        request.result?.metadata?.promptTokens,
        request.result?.metadata?.inputTokens,
        request.result?.metadata?.prompt_tokens,
        request.result?.metadata?.input_tokens,
        request.result?.metadata?.usage?.promptTokens,
        request.result?.metadata?.usage?.inputTokens,
        request.result?.metadata?.usage?.prompt_tokens,
        request.result?.metadata?.usage?.input_tokens
    )) || 0;
}

export function parseCreditDetailsNanoAiu(detailsValue: unknown): number {
    const details = asString(detailsValue, '');
    const match = details.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s+(?:ai\s+)?credits?\b/i);
    if (!match) {
        return 0;
    }

    const credits = Number(match[1]);
    return Number.isFinite(credits) ? Math.round(credits * NANO_AIU_PER_AIC) : 0;
}

function getChatRequestNanoAiu(request: any): number {
    const direct = toNumber(firstDefined(
        request.copilotUsageNanoAiu,
        request.nanoAiu,
        request.result?.metadata?.copilotUsageNanoAiu,
        request.result?.metadata?.nanoAiu,
        request.result?.metadata?.usage?.copilotUsageNanoAiu,
        request.result?.metadata?.usage?.nanoAiu
    ));
    if (direct !== undefined) {
        return direct;
    }

    return parseCreditDetailsNanoAiu(request.result?.details);
}

/** Parse VS Code chatSessions JSONL files, which store user-facing transcript state. */
export function parseChatSessionLog(filePath: string): SessionSummary | undefined {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    let state: any = {};
    let title: string | undefined;

    for (const line of lines) {
        try {
            const raw = JSON.parse(line);

            if (raw.kind === 0 && raw.v && typeof raw.v === 'object') {
                state = raw.v;
                continue;
            }

            if (Array.isArray(raw.k)) {
                if (raw.kind === 2) {
                    pushNestedArray(state, raw.k, raw.v, raw.i);
                } else if (raw.kind === 3) {
                    deleteNestedValue(state, raw.k);
                } else {
                    setNestedValue(state, raw.k, raw.v);
                }
                if (raw.k.length === 1 && raw.k[0] === 'customTitle' && typeof raw.v === 'string') {
                    title = raw.v;
                }
            }
        } catch {
            // skip malformed lines
        }
    }

    const sessionId = asString(state.sessionId, path.basename(filePath, '.jsonl'));
    const baseTimestamp = toTimestamp(state.creationDate, 0);
    const selectedModel = state.inputState?.selectedModel;
    const fallbackModel = asString(firstDefined(
        selectedModel?.identifier,
        selectedModel?.metadata?.id,
        selectedModel?.metadata?.name
    ), 'unknown');

    const requests = Array.isArray(state.requests) ? state.requests : [];
    const entries: LogEntry[] = [];

    for (let i = 0; i < requests.length; i++) {
        const request = requests[i];
        if (!request || typeof request !== 'object') {
            continue;
        }

        const contentPreview = extractChatText(request.message).trim();
        if (!contentPreview) {
            continue;
        }

        const timestamp = toTimestamp(request.timestamp, baseTimestamp + i);
        const requestId = asString(request.requestId, `chat-request-${i}`);

        entries.push({
            ts: timestamp,
            dur: 0,
            sid: sessionId,
            type: 'user_message',
            name: 'user_message',
            spanId: requestId,
            status: 'ok',
            attrs: {
                content: contentPreview,
            },
        });

        const responseParts = Array.isArray(request.response) ? request.response : [];
        const hasResponse = responseParts.length > 0 ||
            request.result ||
            request.elapsedMs !== undefined ||
            request.completionTokens !== undefined;

        if (!hasResponse) {
            continue;
        }

        const turnTimestamp = timestamp + 1;
        const inputTokens = getChatRequestInputTokens(request);
        const outputTokens = getChatRequestOutputTokens(request);
        const nanoAiu = getChatRequestNanoAiu(request);

        entries.push({
            ts: turnTimestamp,
            dur: getChatRequestDurationMs(request, timestamp),
            sid: sessionId,
            type: 'llm_request',
            name: asString(request.agent?.name, 'chat'),
            spanId: `${requestId}-response`,
            parentSpanId: requestId,
            status: 'ok',
            attrs: {
                model: asString(request.modelId, fallbackModel),
                debugName: asString(request.agent?.name, 'chat'),
                inputTokens,
                outputTokens,
                cachedTokens: 0,
                copilotUsageNanoAiu: nanoAiu,
                responseId: request.responseId,
            },
        });

        let toolIndex = 0;
        for (const part of responseParts) {
            if (!part || typeof part !== 'object' || part.kind !== 'toolInvocationSerialized') {
                continue;
            }

            const toolName = normalizeChatToolName(part);
            entries.push({
                ts: turnTimestamp + toolIndex + 1,
                dur: 0,
                sid: sessionId,
                type: 'tool_call',
                name: toolName,
                spanId: asString(part.toolCallId, `${requestId}-tool-${toolIndex}`),
                parentSpanId: `${requestId}-response`,
                status: part.isComplete === false ? 'pending' : 'ok',
                attrs: {
                    displayLabel: getChatToolDisplayLabel(part),
                    source: getChatToolSource(part),
                    toolKind: getChatToolKind(part),
                    resultCount: getChatToolResultCount(part),
                    toolCallId: part.toolCallId,
                },
            });
            toolIndex++;
        }
    }

    const summary = parseEntries(entries);
    if (!summary) {
        return undefined;
    }

    summary.title = title || (typeof state.customTitle === 'string' ? state.customTitle : undefined);
    summary.sourceType = 'chatSession';
    return summary;
}

export function findSiblingChatSessionLog(debugLogFilePath: string): string | undefined {
    if (path.basename(path.dirname(debugLogFilePath)) === 'chatSessions') {
        return fs.existsSync(debugLogFilePath) ? debugLogFilePath : undefined;
    }

    if (path.basename(debugLogFilePath) !== 'main.jsonl') {
        return undefined;
    }

    const sessionId = path.basename(path.dirname(debugLogFilePath));
    const debugLogsDir = path.dirname(path.dirname(debugLogFilePath));
    const copilotChatDir = path.dirname(debugLogsDir);
    const workspaceStorageDir = path.dirname(copilotChatDir);
    const candidate = path.join(workspaceStorageDir, 'chatSessions', `${sessionId}.jsonl`);

    return fs.existsSync(candidate) ? candidate : undefined;
}

export function parseCopilotSessionFile(filePath: string): ParsedSessionFile | undefined {
    if (path.basename(path.dirname(filePath)) === 'chatSessions') {
        const summary = parseChatSessionLog(filePath);
        return summary ? { summary, sourceFile: filePath, sourceType: 'chatSession' } : undefined;
    }

    const debugSummary = parseDebugLog(filePath);
    if (debugSummary && debugSummary.userMessages.length > 0) {
        return { summary: debugSummary, sourceFile: filePath, sourceType: 'debugLog' };
    }

    const chatSessionLog = findSiblingChatSessionLog(filePath);
    const chatSummary = chatSessionLog ? parseChatSessionLog(chatSessionLog) : undefined;
    if (chatSummary && chatSummary.userMessages.length > 0) {
        return { summary: chatSummary, sourceFile: chatSessionLog, sourceType: 'chatSession' };
    }

    if (debugSummary) {
        return { summary: debugSummary, sourceFile: filePath, sourceType: 'debugLog' };
    }

    return chatSummary && chatSessionLog
        ? { summary: chatSummary, sourceFile: chatSessionLog, sourceType: 'chatSession' }
        : undefined;
}

export function parseCopilotSessionLog(filePath: string): SessionSummary | undefined {
    return parseCopilotSessionFile(filePath)?.summary;
}

/** Title-generation debugNames that should be filtered from user-visible turns */
const TITLE_GENERATION_NAMES = new Set(['title', 'generate_title', 'generate title', 'generateTitle', 'title-generation']);

function isTitleGenerationRequest(entry: LogEntry): boolean {
    const name = (entry.attrs.debugName || '').toLowerCase();
    return TITLE_GENERATION_NAMES.has(name);
}

function getSubagentToolCalls(summary: SessionSummary): ToolCallSummary[] {
    const calls: ToolCallSummary[] = [];
    for (const msg of summary.userMessages) {
        for (const turn of msg.modelTurns) {
            for (const tc of turn.toolCalls) {
                if (tc.isSubagent) {
                    calls.push(tc);
                }
            }
        }
    }
    return calls;
}

function findUnattachedSubagentToolCall(summary: SessionSummary, predicate: (tc: ToolCallSummary) => boolean): ToolCallSummary | undefined {
    return getSubagentToolCalls(summary).find(tc => !tc.subagentSummary && predicate(tc));
}

function readChildParentSpanId(filePath: string): string | undefined {
    let content: string;
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, 'r');
        const stat = fs.fstatSync(fd);
        const bytesToRead = Math.min(stat.size, 64 * 1024);
        const buffer = Buffer.alloc(bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
        content = buffer.toString('utf-8', 0, bytesRead);
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore close failures */ }
        }
    }

    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines.slice(0, 25)) {
        try {
            const normalizedEntries = normalizeParsedEntries(JSON.parse(line), 0);
            for (const entry of normalizedEntries) {
                if (entry.parentSpanId && entry.type !== 'child_session_ref') {
                    return entry.parentSpanId;
                }
            }
        } catch {
            continue;
        }
    }

    return undefined;
}

function findLastModelTurn(summary: SessionSummary): { message: UserMessageSummary; turn: ModelTurnSummary } | undefined {
    for (let msgIndex = summary.userMessages.length - 1; msgIndex >= 0; msgIndex--) {
        const message = summary.userMessages[msgIndex];
        const turn = message.modelTurns[message.modelTurns.length - 1];
        if (turn) {
            return { message, turn };
        }
    }
    return undefined;
}

function createSyntheticSubagentCall(orphanFile: string, timestamp: number, childSummary: SessionSummary): ToolCallSummary {
    const label = path.basename(orphanFile, '.jsonl')
        .replace(/^runSubagent-/, '')
        .replace(/[-_]+/g, ' ')
        .trim() || 'in-progress';

    return {
        name: 'runSubagent',
        displayLabel: `Subagent: ${label}`,
        durationMs: 0,
        timestamp,
        spanId: `${path.basename(orphanFile, '.jsonl')}-synthetic`,
        isSubagent: true,
        source: 'debug-log',
        subagentSummary: childSummary,
        subagentInProgress: true,
    };
}

function attachInProgressSubagents(summary: SessionSummary, sessionDir: string, childRefs: LogEntry[]): void {
    const referencedChildFiles = new Set(
        childRefs
            .map(ref => typeof ref.attrs.childLogFile === 'string' ? path.basename(ref.attrs.childLogFile) : undefined)
            .filter((value): value is string => !!value)
    );

    let dirFiles: string[];
    try {
        dirFiles = fs.readdirSync(sessionDir);
    } catch {
        return;
    }

    const orphanFiles = dirFiles.filter(file =>
        file.startsWith('runSubagent-') &&
        file.endsWith('.jsonl') &&
        !referencedChildFiles.has(file)
    );
    if (orphanFiles.length === 0) {
        return;
    }

    for (const orphanFile of orphanFiles) {
        const childFile = path.join(sessionDir, orphanFile);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(childFile);
        } catch {
            continue;
        }

        if (Date.now() - stat.mtimeMs > IN_PROGRESS_SUBAGENT_STALE_MS) {
            continue;
        }

        const childSummary = parseDebugLog(childFile);
        if (!childSummary) { continue; }
        childSummary.inProgress = true;

        const unmatched = getSubagentToolCalls(summary).filter(tc => !tc.subagentSummary);
        const childParentSpanId = readChildParentSpanId(childFile);
        let target = childParentSpanId
            ? unmatched.find(tc => tc.spanId === childParentSpanId)
            : undefined;

        if (!target) {
            target = unmatched.find(tc => !!tc.toolCallId && orphanFile.includes(String(tc.toolCallId)));
        }

        if (!target && unmatched.length === 1 && orphanFiles.length === 1) {
            target = unmatched[0];
        }

        if (target) {
            target.subagentSummary = childSummary;
            target.subagentInProgress = true;
            continue;
        }

        if (orphanFiles.length === 1 && unmatched.length === 0) {
            const lastTurn = findLastModelTurn(summary);
            if (lastTurn) {
                const synthetic = createSyntheticSubagentCall(orphanFile, stat.mtimeMs, childSummary);
                lastTurn.turn.toolCalls.push(synthetic);
                lastTurn.message.toolCalls.push(synthetic);
            }
        }
    }
}

/** Parse a debug log file from disk */
export function parseDebugLog(filePath: string): SessionSummary | undefined {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entries: LogEntry[] = [];

    for (const line of lines) {
        try {
            const raw = JSON.parse(line);
            const normalizedEntries = normalizeParsedEntries(raw, entries.length);

            for (const entry of normalizedEntries) {
                // Filter out title-generation LLM requests (internal Copilot calls)
                if (entry.type === 'llm_request' && isTitleGenerationRequest(entry)) {
                    continue;
                }
                entries.push(entry);
            }
        } catch {
            // skip malformed lines
        }
    }

    const summary = parseEntries(entries);
    if (!summary) { return undefined; }

    // Parse subagent child log files and attach summaries
    const sessionDir = path.dirname(filePath);
    const childRefs = entries.filter(e => e.type === 'child_session_ref' && e.attrs.childLogFile);

    for (const ref of childRefs) {
        const childFile = path.join(sessionDir, ref.attrs.childLogFile as string);
        if (!fs.existsSync(childFile)) { continue; }
        const childSummary = parseDebugLog(childFile);
        if (!childSummary) { continue; }

        const parentSpanId = ref.parentSpanId;
        const target = parentSpanId
            ? findUnattachedSubagentToolCall(summary, tc => tc.spanId === parentSpanId)
            : findUnattachedSubagentToolCall(summary, tc => Math.abs(tc.timestamp - ref.ts) < 5000);

        if (target) {
            target.subagentSummary = childSummary;
        }
    }

    if (path.basename(filePath) === 'main.jsonl') {
        attachInProgressSubagents(summary, sessionDir, childRefs);
    }

    // Roll up subagent costs into parent message and session totals
    for (const msg of summary.userMessages) {
        for (const turn of msg.modelTurns) {
            for (const tc of turn.toolCalls) {
                if (tc.subagentSummary) {
                    const sub = tc.subagentSummary;
                    msg.totalInputTokens += sub.totalInputTokens;
                    msg.totalOutputTokens += sub.totalOutputTokens;
                    msg.totalCachedTokens += sub.totalCachedTokens;
                    msg.totalTokens += sub.totalTokens;
                    msg.totalNanoAiu += sub.totalNanoAiu;
                    msg.totalDurationMs += sub.totalDurationMs;
                }
            }
        }
    }
    // Recompute session totals from updated message totals
    summary.totalInputTokens = summary.userMessages.reduce((s, m) => s + m.totalInputTokens, 0);
    summary.totalOutputTokens = summary.userMessages.reduce((s, m) => s + m.totalOutputTokens, 0);
    summary.totalCachedTokens = summary.userMessages.reduce((s, m) => s + m.totalCachedTokens, 0);
    summary.totalTokens = summary.userMessages.reduce((s, m) => s + m.totalTokens, 0);
    summary.totalNanoAiu = summary.userMessages.reduce((s, m) => s + m.totalNanoAiu, 0);
    summary.totalDurationMs = summary.userMessages.reduce((s, m) => s + m.totalDurationMs, 0);
    summary.toolCallCount = summary.userMessages.reduce(
        (s, m) => s + m.modelTurns.reduce((turnTotal, t) => turnTotal + t.toolCalls.length, 0),
        0
    );

    // Parse prompt composition from system_prompt and tools files
    summary.promptComposition = parsePromptComposition(sessionDir, entries);
    summary.sourceType = 'debugLog';

    return summary;
}

/** Rough token estimate: ~4 chars per token for o200k_base */
export function estimateTokens(value: number | string): number {
    const chars = typeof value === 'string' ? value.length : value;
    return Math.round(chars / 4);
}

function parsePromptComposition(sessionDir: string, entries: LogEntry[]): PromptComposition | undefined {
    const llmRequests = entries.filter(e => e.type === 'llm_request');
    if (llmRequests.length === 0) { return undefined; }

    // Collect all distinct system prompt and tools files
    const spFiles = new Set(llmRequests.map(e => e.attrs.systemPromptFile).filter(Boolean) as string[]);
    const tFiles = new Set(llmRequests.map(e => e.attrs.toolsFile).filter(Boolean) as string[]);

    const systemPrompts: { [filename: string]: { chars: number; estimatedTokens: number } } = {};
    for (const spFile of spFiles) {
        const spPath = path.join(sessionDir, spFile);
        if (!fs.existsSync(spPath)) { continue; }
        try {
            const raw = JSON.parse(fs.readFileSync(spPath, 'utf-8'));
            const content = typeof raw === 'string' ? raw : (raw.content || JSON.stringify(raw));
            systemPrompts[spFile] = { chars: content.length, estimatedTokens: estimateTokens(content.length) };
        } catch { /* skip */ }
    }

    const toolSets: { [filename: string]: ToolDefinitionSize[] } = {};
    for (const toolsFile of tFiles) {
        const toolsPath = path.join(sessionDir, toolsFile);
        if (!fs.existsSync(toolsPath)) { continue; }
        try {
            const raw = JSON.parse(fs.readFileSync(toolsPath, 'utf-8'));
            const toolsContent = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw);
            const toolsArray = JSON.parse(toolsContent);
            const defs: ToolDefinitionSize[] = [];
            if (Array.isArray(toolsArray)) {
                for (const tool of toolsArray) {
                    const name = tool.name || tool.function?.name || 'unknown';
                    const chars = JSON.stringify(tool).length;
                    defs.push({ name, chars, estimatedTokens: estimateTokens(chars) });
                }
                defs.sort((a, b) => b.chars - a.chars);
            }
            toolSets[toolsFile] = defs;
        } catch { /* skip */ }
    }

    return { toolSets, systemPrompts };
}

/**
 * Incremental JSONL reader: reads only bytes from `fromOffset` to end of file.
 * Returns parsed entries and the new byte offset for next read.
 */
export function readEntriesIncremental(filePath: string, fromOffset: number): { entries: LogEntry[]; newOffset: number } {
    const stat = fs.statSync(filePath);
    if (stat.size <= fromOffset) {
        return { entries: [], newOffset: fromOffset };
    }

    const fd = fs.openSync(filePath, 'r');
    const bufSize = stat.size - fromOffset;
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, fromOffset);
    fs.closeSync(fd);

    const chunk = buf.toString('utf-8');
    const lines = chunk.split('\n').filter(l => l.trim());
    const entries: LogEntry[] = [];

    for (const line of lines) {
        try {
            const raw = JSON.parse(line);
            const normalizedEntries = normalizeParsedEntries(raw, entries.length);

            for (const entry of normalizedEntries) {
                if (entry.type === 'llm_request' && isTitleGenerationRequest(entry)) {
                    continue;
                }
                entries.push(entry);
            }
        } catch {
            // skip malformed / partial lines
        }
    }

    return { entries, newOffset: stat.size };
}

export function formatNumber(n: number): string {
    return n.toLocaleString();
}

export function formatAic(nanoAiu: number): string {
    return (nanoAiu / NANO_AIU_PER_AIC).toFixed(2);
}

export function formatDuration(ms: number): string {
    if (ms < 1000) { return `${ms}ms`; }
    return `${(ms / 1000).toFixed(1)}s`;
}
