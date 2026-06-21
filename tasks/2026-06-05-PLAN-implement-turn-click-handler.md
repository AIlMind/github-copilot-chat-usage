# VS Code Copilot Usage Tracker: Click-to-Debug-Log Reveal + Failed Turn Highlighting Implementation Plan

## Purpose

Implement two related improvements in the VS Code Copilot Usage Tracker extension:

1. In the `COPILOT USAGE: TOKEN USAGE` tree, clicking a usage node should reveal the closest matching node or line in Agent Debug Logs.
2. The Usage tree should make failed or wasteful turns visually obvious, especially repeated failed terminal-command attempts such as invoking `rg` on a Windows machine where `rg` is unavailable.

The broader product goal is to help human developers understand where AI Credits, tokens, and time are being wasted.

This plan is intentionally explicit and repetitive so that an older/smaller LLM model can implement it safely without making broad architectural guesses.

---

## Current code facts to preserve

Use these facts as anchors while editing:

- `extension.ts` owns the Usage tree UI.
- `TreeItemData` is currently a union near `// ---- Tree View ----` with node kinds such as `session`, `userMessage`, `modelTurn`, `turnToolCall`, `mergedItem`, `commandsGroup`, `commandItem`, `insights`, and `stat`.
- `UsageTreeProvider` implements `vscode.TreeDataProvider<TreeItemData>` and has `getTreeItem` and `getChildren` methods.
- `activate()` creates the tree view using `vscode.window.createTreeView('copilotUsageTree', { treeDataProvider: treeProvider, showCollapseAll: true })`.
- `parser.ts` already normalizes raw debug entries into `LogEntry` with useful fields including `spanId`, `parentSpanId`, `status`, `attrs.responseId`, `attrs.args`, `attrs.result`, and `attrs.toolCallId`, but many of those fields are not currently preserved in `ToolCallSummary` / `ModelTurnSummary`.
- `parseEntries()` currently groups model turns and tool calls using timestamp boundaries because `spanId` values can be recycled across messages.
- `graph.ts` has `SessionGraph`, compact `GraphMessage` / `GraphTurn` / `GraphToolCall` projections, command extraction, and a `computeRisks()` method. It currently flags risky commands but does not detect repeated failed commands.
- `participant.ts` serializes `SessionGraph` data for the `@usage` chat participant.

Do not rewrite the extension. Add small, testable pieces.

---

## Important VS Code API constraints

Use these constraints while implementing:

- `TreeItem.command` can run a command when the tree item is selected.
- `TreeItem.iconPath` can be a `ThemeIcon`.
- `new vscode.ThemeIcon(id, new vscode.ThemeColor(colorId))` can color tree icons.
- VS Code does not provide a simple `TreeItem.foreground = red` API. Avoid trying to set arbitrary text colors.
- `TreeItemLabel.highlights` only highlights character ranges. It does not give semantic red/yellow coloring.
- `TreeView.reveal(element, { select, focus, expand })` only works for a tree view your extension owns, and the provider must implement `getParent`.
- If the target Agent Debug Logs panel belongs to another extension and exposes no public command/API, this extension cannot directly select a private tree item there. In that case, use a reliable fallback: open the raw `main.jsonl` / source JSONL file at the best matching line.

---

## Implementation phases

Implement in this order. Compile after each phase if possible.

1. Add parser provenance and failure types.
2. Preserve source-file/source-line and raw identifiers through parsing.
3. Add failure classification helpers.
4. Add reveal target helpers in `extension.ts`.
5. Add Usage tree click commands.
6. Add raw-log fallback reveal.
7. Add colored icons and failure badges in Usage tree.
8. Add top-level `Failures` node sorted by likely token waste.
9. Update `SessionGraph` serialization for `@usage`.
10. Add tests or minimal fixture-based validation.

---

## Phase 1: Extend parser types

### File

`parser.ts`

### Add these interfaces near the existing exported interfaces

```ts
export interface DebugSourceRef {
    sessionId: string;
    sourceFile?: string;
    sourceLine?: number;
    timestamp: number;
    type: 'user_message' | 'llm_request' | 'tool_call' | 'merged_message' | 'child_session_ref';
    spanId?: string;
    parentSpanId?: string;
    turnId?: string;
    responseId?: string;
    toolCallId?: string;
}

export type FailureSeverity = 'info' | 'warning' | 'error';

export interface FailureInfo {
    isFailure: boolean;
    severity: FailureSeverity;
    reason?: string;
    normalizedKey?: string;
}
```

### Extend `LogEntry`

Add optional source fields:

```ts
export interface LogEntry {
    // existing fields...
    sourceFile?: string;
    sourceLine?: number;
}
```

### Extend `ToolCallSummary`

Add fields but do not remove existing fields:

```ts
export interface ToolCallSummary {
    // existing fields...
    spanId?: string;
    parentSpanId?: string;
    status?: string;
    args?: string;
    result?: string;
    debugRef?: DebugSourceRef;
    failure?: FailureInfo;
}
```

### Extend `ModelTurnSummary`

```ts
export interface ModelTurnSummary {
    // existing fields...
    spanId?: string;
    parentSpanId?: string;
    status?: string;
    responseId?: string;
    debugRef?: DebugSourceRef;
    failure?: FailureInfo;
}
```

### Extend `MergedMessageInfo`

```ts
export interface MergedMessageInfo {
    // existing fields...
    debugRef?: DebugSourceRef;
}
```

### Extend `UserMessageSummary`

```ts
export interface UserMessageSummary {
    // existing fields...
    debugRef?: DebugSourceRef;
    failure?: FailureInfo;
}
```

### Extend `SessionSummary`

```ts
export interface SessionSummary {
    // existing fields...
    sourceFile?: string;
}
```

### Compile expectation

After adding fields only, TypeScript should compile because all new fields are optional.

---

## Phase 2: Preserve source file, source line, IDs, args, result, and status

### File

`parser.ts`

### Add helper: `makeDebugSourceRef`

Place near `parseEntries()` or near other helper functions.

```ts
function makeDebugSourceRef(entry: LogEntry): DebugSourceRef {
    return {
        sessionId: entry.sid,
        sourceFile: entry.sourceFile,
        sourceLine: entry.sourceLine,
        timestamp: entry.ts,
        type: entry.type as DebugSourceRef['type'],
        spanId: entry.spanId,
        parentSpanId: entry.parentSpanId,
        turnId: entry.attrs.turnId,
        responseId: entry.attrs.responseId,
        toolCallId: entry.attrs.toolCallId,
    };
}
```

If TypeScript complains about `entry.type as DebugSourceRef['type']`, make this safer:

```ts
const supportedTypes = new Set(['user_message', 'llm_request', 'tool_call', 'merged_message', 'child_session_ref']);
const type = supportedTypes.has(entry.type) ? entry.type as DebugSourceRef['type'] : 'tool_call';
```

### Change `parseDebugLog` to keep original JSONL line numbers

Current pattern:

```ts
const lines = content.split('\n').filter(l => l.trim());
for (const line of lines) {
    ...
}
```

Replace with:

```ts
const lines = content.split('\n');
const entries: LogEntry[] = [];

for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line.trim()) { continue; }

    try {
        const raw = JSON.parse(line);
        const normalizedEntries = normalizeParsedEntries(raw, entries.length);

        for (const entry of normalizedEntries) {
            entry.sourceFile = filePath;
            entry.sourceLine = lineIndex + 1;

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
```

Important: assign `sourceFile` and `sourceLine` before pushing each entry. Inline tool-call entries produced by `normalizeParsedEntries()` should receive the same source line as their parent raw line.

### Update `readEntriesIncremental` similarly

This function cannot easily know absolute line numbers from a byte offset. Do the minimum:

```ts
entry.sourceFile = filePath;
```

Leave `sourceLine` undefined for incremental entries unless you add a safe line-counting implementation. Do not spend time here unless tests require it.

### Set `summary.sourceFile`

In `parseDebugLog`, after `summary.sourceType = 'debugLog';`, add:

```ts
summary.sourceFile = filePath;
```

In `parseCopilotSessionFile`, after summaries are created, also set the returned summary source file if missing:

```ts
summary.sourceFile = filePath;
```

Be careful not to create duplicate summaries; just set the property before return.

### Preserve fields in model turns

In `parseEntries()`, when pushing a `ModelTurnSummary`, add:

```ts
spanId: r.spanId,
parentSpanId: r.parentSpanId,
status: r.status,
responseId: r.attrs.responseId,
debugRef: makeDebugSourceRef(r),
```

### Preserve fields in tool summaries

The mapping inside each model turn currently creates tool calls like:

```ts
toolCalls: allTurnTools.map(t => ({
    name: t.name,
    displayLabel: getToolDisplayLabel(t.name, t.attrs.args, t.attrs.displayLabel),
    durationMs: t.dur,
    timestamp: t.ts,
    isSubagent: t.name === 'runSubagent',
    source: t.attrs.source,
    toolKind: t.attrs.toolKind,
    resultCount: t.attrs.resultCount,
    toolCallId: t.attrs.toolCallId,
}))
```

Replace this with a helper to avoid duplicating logic:

```ts
function makeToolCallSummary(entry: LogEntry): ToolCallSummary {
    const displayLabel = getToolDisplayLabel(entry.name, entry.attrs.args, entry.attrs.displayLabel);
    const summary: ToolCallSummary = {
        name: entry.name,
        displayLabel,
        durationMs: entry.dur,
        timestamp: entry.ts,
        isSubagent: entry.name === 'runSubagent',
        source: entry.attrs.source,
        toolKind: entry.attrs.toolKind,
        resultCount: entry.attrs.resultCount,
        toolCallId: entry.attrs.toolCallId,
        spanId: entry.spanId,
        parentSpanId: entry.parentSpanId,
        status: entry.status,
        args: entry.attrs.args,
        result: entry.attrs.result,
        debugRef: makeDebugSourceRef(entry),
    };
    summary.failure = classifyToolCallFailure(summary);
    return summary;
}
```

Then use:

```ts
toolCalls: allTurnTools.map(makeToolCallSummary)
```

Also use `group.allToolCalls.map(makeToolCallSummary)` for `allToolCallSummaries`.

### Preserve fields on merged continuations

Current merged message push:

```ts
prev.mergedMessages.push({
    content: msgContent.slice(0, 80).replace(/[\r\n]+/g, ' '),
    timestamp: group.msg.ts,
    spanId: group.msg.spanId,
});
```

Change to:

```ts
prev.mergedMessages.push({
    content: msgContent.slice(0, 80).replace(/[\r\n]+/g, ' '),
    timestamp: group.msg.ts,
    spanId: group.msg.spanId,
    debugRef: makeDebugSourceRef(group.msg),
});
```

### Preserve fields on user messages

When pushing `messageSummaries`, add:

```ts
debugRef: makeDebugSourceRef(group.primaryMsg),
```

Set `failure` after model turns are created; see Phase 3.

---

## Phase 3: Add failure classification

### File

`parser.ts`

### Add helper constants

Place near `getToolDisplayLabel()` or after it.

```ts
const FAILURE_OK: FailureInfo = { isFailure: false, severity: 'info' };

const COMMAND_NOT_FOUND_PATTERNS: RegExp[] = [
    /not recognized as (?:the name of )?(?:a cmdlet|function|script file|operable program)/i,
    /the term ['"`]?.+?['"`]? is not recognized/i,
    /command not found/i,
    /no such file or directory/i,
    /ENOENT/i,
    /exit code\s+(?:127|9009)\b/i,
];
```

### Add helper: `safeJsonParse`

```ts
function safeJsonParse(value: string | undefined): any | undefined {
    if (!value) { return undefined; }
    try { return JSON.parse(value); } catch { return undefined; }
}
```

### Add helper: `extractCommandNameFromToolCall`

Use args first because `displayLabel` is truncated.

```ts
export function extractCommandNameFromToolCall(call: Pick<ToolCallSummary, 'name' | 'args' | 'displayLabel'>): string | undefined {
    if (call.name !== 'run_in_terminal') { return undefined; }

    const args = safeJsonParse(call.args);
    let command = typeof args?.command === 'string' ? args.command : undefined;

    if (!command) {
        const match = call.displayLabel.match(/^Ran:\s*(?:cd\s+[^;]+;\s*)?(.+)/);
        command = match?.[1];
    }

    if (!command) { return undefined; }

    let cmd = command.trim();

    // Handle common shell wrappers.
    cmd = cmd.replace(/^cmd\s+\/c\s+/i, '');
    cmd = cmd.replace(/^powershell(?:\.exe)?\s+-[^\s]+\s+/i, '');
    cmd = cmd.replace(/^pwsh(?:\.exe)?\s+-[^\s]+\s+/i, '');

    // Handle PowerShell variable assignment: $x = rg ...
    const assignMatch = cmd.match(/^\$\w+\s*=\s*(.+)/);
    if (assignMatch) {
        cmd = assignMatch[1].trim();
    }

    const exe = cmd.split(/\s+/)[0]?.replace(/["'`]/g, '').trim();
    if (!exe || exe.startsWith('$') || exe.startsWith('(') || exe.startsWith('{')) {
        return undefined;
    }

    return exe;
}
```

### Add helper: `classifyToolCallFailure`

```ts
export function classifyToolCallFailure(call: Pick<ToolCallSummary, 'name' | 'displayLabel' | 'status' | 'args' | 'result'>): FailureInfo {
    const status = call.status || 'ok';
    const result = call.result || '';
    const displayLabel = call.displayLabel || '';
    const args = call.args || '';
    const haystack = `${status}\n${displayLabel}\n${args}\n${result}`;

    // Explicit non-ok status is a failure, except pending should be warning.
    if (status && !/^ok$/i.test(status)) {
        return {
            isFailure: true,
            severity: /^pending$/i.test(status) ? 'warning' : 'error',
            reason: `Tool status: ${status}`,
            normalizedKey: `tool-status:${status.toLowerCase()}`,
        };
    }

    if (call.name === 'run_in_terminal') {
        const exe = extractCommandNameFromToolCall(call as ToolCallSummary);
        const commandMissing = COMMAND_NOT_FOUND_PATTERNS.some(pattern => pattern.test(haystack));

        if (commandMissing && exe) {
            return {
                isFailure: true,
                severity: 'error',
                reason: `Terminal command unavailable: ${exe}`,
                normalizedKey: `missing-command:${exe.toLowerCase()}`,
            };
        }

        // Special case: user explicitly cares about rg. Catch weaker result strings.
        if (exe?.toLowerCase() === 'rg' && /rg/i.test(haystack) && /not recognized|not found|ENOENT|127|9009/i.test(haystack)) {
            return {
                isFailure: true,
                severity: 'error',
                reason: 'Terminal command unavailable: rg',
                normalizedKey: 'missing-command:rg',
            };
        }

        // Generic command failed with a non-zero exit marker.
        if (/exit code\s+[1-9]\d*\b/i.test(haystack)) {
            return {
                isFailure: true,
                severity: 'warning',
                reason: exe ? `Terminal command exited non-zero: ${exe}` : 'Terminal command exited non-zero',
                normalizedKey: exe ? `nonzero-command:${exe.toLowerCase()}` : 'nonzero-command',
            };
        }
    }

    return FAILURE_OK;
}
```

### Add helper: `classifyTurnFailure`

```ts
function classifyTurnFailure(turn: Pick<ModelTurnSummary, 'status' | 'toolCalls'>): FailureInfo {
    if (turn.status && !/^ok$/i.test(turn.status)) {
        return {
            isFailure: true,
            severity: /^pending$/i.test(turn.status) ? 'warning' : 'error',
            reason: `Model turn status: ${turn.status}`,
            normalizedKey: `turn-status:${turn.status.toLowerCase()}`,
        };
    }

    const failedToolCalls = turn.toolCalls.filter(tc => tc.failure?.isFailure);
    if (failedToolCalls.length === 0) {
        return FAILURE_OK;
    }

    const firstFailure = failedToolCalls[0].failure;
    const hasError = failedToolCalls.some(tc => tc.failure?.severity === 'error');
    return {
        isFailure: true,
        severity: hasError ? 'error' : 'warning',
        reason: failedToolCalls.length === 1
            ? firstFailure?.reason || 'Failed tool call'
            : `${failedToolCalls.length} failed tool calls`,
        normalizedKey: firstFailure?.normalizedKey,
    };
}
```

### Apply turn failure after constructing tool calls

In `parseEntries()`, it may be easiest to build a local variable before pushing:

```ts
const turnToolSummaries = allTurnTools.map(makeToolCallSummary);
const turnSummary: ModelTurnSummary = {
    // existing fields...
    toolCalls: turnToolSummaries,
    // new fields...
};
turnSummary.failure = classifyTurnFailure(turnSummary);
modelTurns.push(turnSummary);
```

### Apply user message failure

After `modelTurns` exists and before `messageSummaries.push`, compute:

```ts
const failedTurns = modelTurns.filter(t => t.failure?.isFailure);
const messageFailure: FailureInfo = failedTurns.length === 0
    ? FAILURE_OK
    : {
        isFailure: true,
        severity: failedTurns.some(t => t.failure?.severity === 'error') ? 'error' : 'warning',
        reason: `${failedTurns.length} failed turn${failedTurns.length === 1 ? '' : 's'}`,
        normalizedKey: failedTurns[0].failure?.normalizedKey,
    };
```

Add to the pushed user message:

```ts
failure: messageFailure,
```

---

## Phase 4: Add reveal target types and helpers

### File

`extension.ts`

### Import new types

Update the parser import list to include:

```ts
DebugSourceRef,
FailureInfo,
```

### Add `UsageRevealTarget`

Place near `TreeItemData`.

```ts
interface UsageRevealTarget {
    sessionId: string;
    sourceFile?: string;
    sourceLine?: number;
    timestamp: number;
    kind: TreeItemData['kind'];
    spanId?: string;
    parentSpanId?: string;
    responseId?: string;
    toolCallId?: string;
    messageIndex?: number;
    turnIndex?: number;
    label?: string;
}
```

### Add helper: `targetFromDebugRef`

```ts
function targetFromDebugRef(kind: TreeItemData['kind'], debugRef: DebugSourceRef | undefined, extra?: Partial<UsageRevealTarget>): UsageRevealTarget | undefined {
    if (!debugRef) { return undefined; }
    return {
        sessionId: debugRef.sessionId,
        sourceFile: debugRef.sourceFile,
        sourceLine: debugRef.sourceLine,
        timestamp: debugRef.timestamp,
        kind,
        spanId: debugRef.spanId,
        parentSpanId: debugRef.parentSpanId,
        responseId: debugRef.responseId,
        toolCallId: debugRef.toolCallId,
        ...extra,
    };
}
```

### Add helper: `makeRevealTarget`

```ts
function makeRevealTarget(element: TreeItemData): UsageRevealTarget | undefined {
    switch (element.kind) {
        case 'userMessage':
            return targetFromDebugRef('userMessage', element.message.debugRef, {
                messageIndex: element.index,
                label: element.message.content,
            });
        case 'modelTurn':
            return targetFromDebugRef('modelTurn', element.turn.debugRef, {
                messageIndex: element.msgIndex,
                turnIndex: element.turnIndex,
                label: element.turn.debugName,
            });
        case 'turnToolCall':
            return targetFromDebugRef('turnToolCall', element.call.debugRef, {
                toolCallId: element.call.toolCallId,
                label: element.call.displayLabel,
            });
        case 'mergedItem':
            return targetFromDebugRef('mergedItem', element.info.debugRef, {
                label: element.info.content,
            });
        case 'failureItem':
            return element.target;
        default:
            return undefined;
    }
}
```

This requires adding `failureItem` to `TreeItemData` in Phase 8. If TypeScript complains before Phase 8, add the `failureItem` type early.

---

## Phase 5: Add click commands to Usage tree items

### File

`extension.ts`

### Add helper: `attachRevealCommand`

Place inside or outside `UsageTreeProvider`. Outside is simpler.

```ts
function attachRevealCommand(item: vscode.TreeItem, element: TreeItemData): void {
    const target = makeRevealTarget(element);
    if (!target) { return; }

    item.command = {
        command: 'copilotUsageTracker.revealInAgentDebugLogs',
        title: 'Reveal in Agent Debug Logs',
        arguments: [target],
    };
}
```

### Call it in `getTreeItem`

For these cases, before `return item;`, add:

```ts
attachRevealCommand(item, element);
```

Apply to:

- `userMessage`
- `modelTurn`
- `turnToolCall`
- `mergedItem`
- `failureItem` after Phase 8

Optional: apply to `subagentTurn` if a `debugRef` is available. This may require adding a target case.

### Do not attach reveal commands to stats

Do not attach to `stat`, `spendSummary`, `spendBucket`, `toolDefinitions`, `toolDef`, or general group nodes unless they have a meaningful target.

---

## Phase 6: Implement reveal command with raw-log fallback

### File

`extension.ts`

### Add helper: `findBestLineInJsonl`

This opens the source JSONL and tries exact identifiers first. If no ID match exists, it falls back to nearest timestamp.

```ts
function parseLineTimestamp(raw: any): number | undefined {
    const candidates = [
        raw?.ts,
        raw?.timestamp,
        raw?.time,
        raw?.attrs?.ts,
        raw?.attrs?.timestamp,
    ];
    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) { return value; }
        if (typeof value === 'string') {
            const numeric = Number(value);
            if (Number.isFinite(numeric)) { return numeric; }
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed)) { return parsed; }
        }
    }
    return undefined;
}

function lineMatchesRevealTarget(raw: any, target: UsageRevealTarget): boolean {
    const attrs = raw?.attrs || {};

    if (target.toolCallId) {
        if (raw?.toolCallId === target.toolCallId || attrs.toolCallId === target.toolCallId) { return true; }
        if (Array.isArray(raw?.toolCalls) && raw.toolCalls.some((tc: any) => tc?.toolCallId === target.toolCallId || tc?.id === target.toolCallId)) { return true; }
        if (Array.isArray(raw?.tools) && raw.tools.some((tc: any) => tc?.toolCallId === target.toolCallId || tc?.id === target.toolCallId)) { return true; }
    }

    if (target.responseId && (raw?.responseId === target.responseId || attrs.responseId === target.responseId)) { return true; }
    if (target.spanId && (raw?.spanId === target.spanId || raw?.spanID === target.spanId || raw?.id === target.spanId || attrs.spanId === target.spanId)) { return true; }
    if (target.parentSpanId && (raw?.parentSpanId === target.parentSpanId || raw?.parentSpanID === target.parentSpanId || attrs.parentSpanId === target.parentSpanId)) { return true; }

    return false;
}

function findBestLineInJsonl(filePath: string, target: UsageRevealTarget): number | undefined {
    if (target.sourceLine && target.sourceLine > 0) {
        return target.sourceLine;
    }

    if (!fs.existsSync(filePath)) { return undefined; }

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let bestTimestampLine: number | undefined;
    let bestTimestampDelta = Number.POSITIVE_INFINITY;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) { continue; }

        let raw: any;
        try { raw = JSON.parse(line); } catch { continue; }

        if (lineMatchesRevealTarget(raw, target)) {
            return i + 1;
        }

        const ts = parseLineTimestamp(raw);
        if (ts !== undefined && Number.isFinite(target.timestamp)) {
            const delta = Math.abs(ts - target.timestamp);
            if (delta < bestTimestampDelta) {
                bestTimestampDelta = delta;
                bestTimestampLine = i + 1;
            }
        }
    }

    // Only use timestamp fallback if it is reasonably close.
    // Use 10 seconds because tool calls and continuation events can be slightly offset.
    return bestTimestampDelta <= 10_000 ? bestTimestampLine : undefined;
}
```

### Add helper: `openSourceAtLine`

```ts
async function openSourceAtLine(filePath: string, lineNumber: number | undefined, target: UsageRevealTarget): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const zeroBasedLine = Math.max(0, (lineNumber || 1) - 1);
    const range = new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    const label = target.label ? `: ${target.label}` : '';
    vscode.window.setStatusBarMessage(`Copilot Usage: revealed debug log line ${zeroBasedLine + 1}${label}`, 5000);
}
```

### Add helper: `revealInAgentDebugLogs`

```ts
async function revealInAgentDebugLogs(target: UsageRevealTarget): Promise<void> {
    // MVP: open raw source JSONL at best line.
    // Future: if this extension owns an Agent Debug Logs tree, call treeView.reveal() before this fallback.
    if (!target.sourceFile || !fs.existsSync(target.sourceFile)) {
        vscode.window.showWarningMessage('Copilot Usage: no source debug log file found for this Usage item.');
        return;
    }

    const line = findBestLineInJsonl(target.sourceFile, target);
    await openSourceAtLine(target.sourceFile, line, target);
}
```

### Register command in `activate()`

Add to `context.subscriptions.push(...)` near the other command registrations:

```ts
context.subscriptions.push(
    vscode.commands.registerCommand('copilotUsageTracker.revealInAgentDebugLogs', async (target: UsageRevealTarget) => {
        try {
            await revealInAgentDebugLogs(target);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Copilot Usage: failed to reveal debug log item: ${err?.message || err}`);
        }
    })
);
```

### Optional future external-panel attempt

Do not implement this unless you find a documented command/API exposed by the Agent Debug Logs panel.

If you find a known command, wrap it safely:

```ts
async function tryRevealViaExternalAgentDebugCommand(target: UsageRevealTarget): Promise<boolean> {
    const commands = await vscode.commands.getCommands(true);
    const commandId = commands.find(c => c === 'some.known.documented.command');
    if (!commandId) { return false; }

    try {
        await vscode.commands.executeCommand(commandId, target);
        return true;
    } catch {
        return false;
    }
}
```

Then call it first in `revealInAgentDebugLogs()`. Do not execute guessed commands with guessed argument shapes.

---

## Phase 7: Add colored icons and descriptions for failed nodes

### File

`extension.ts`

### Add icon helpers

Place near tree helpers.

```ts
const failureErrorIcon = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
const failureWarningIcon = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));

function iconForFailure(failure: FailureInfo | undefined): vscode.ThemeIcon | undefined {
    if (!failure?.isFailure) { return undefined; }
    return failure.severity === 'error' ? failureErrorIcon : failureWarningIcon;
}

function hasFailedTools(turn: ModelTurnSummary): boolean {
    return turn.toolCalls.some(tc => tc.failure?.isFailure);
}
```

### Update `userMessage` case

Currently user messages use `new vscode.ThemeIcon('comment')`.

Change:

```ts
item.iconPath = iconForFailure(m.failure) || new vscode.ThemeIcon('comment');
if (m.failure?.isFailure) {
    item.description = `FAILED | ${item.description}`;
    item.contextValue = 'failedUserMessage';
}
```

Also add failure reason to tooltip:

```ts
m.failure?.isFailure ? `Failure: ${m.failure.reason || m.failure.normalizedKey || 'failed turn'}` : undefined,
```

### Update `modelTurn` case

After choosing `turnIcon`, before setting `item.iconPath`, do:

```ts
const failureIcon = iconForFailure(t.failure);
item.iconPath = failureIcon || turnIcon;
if (t.failure?.isFailure) {
    item.description = `FAILED | ${item.description}`;
    item.contextValue = 'failedModelTurn';
}
```

Do not leave the old unconditional `item.iconPath = turnIcon` below this.

Add to tooltip:

```ts
t.failure?.isFailure ? `Failure: ${t.failure.reason || t.failure.normalizedKey || 'failed turn'}` : '',
```

### Update `turnToolCall` case

After the existing icon selection logic, override with failure icon:

```ts
const failureIcon = iconForFailure(c.failure);
if (failureIcon) {
    item.iconPath = failureIcon;
    item.description = item.description ? `FAILED | ${item.description}` : 'FAILED';
    item.contextValue = 'failedToolCall';
}
```

Add to tooltip:

```ts
c.failure?.isFailure ? `Failure: ${c.failure.reason || c.failure.normalizedKey || 'failed tool call'}` : undefined,
c.status ? `Status: ${c.status}` : undefined,
```

### Use icons, not text color

Do not attempt to set arbitrary text color. This is intentionally not part of the VS Code `TreeItem` API.

---

## Phase 8: Add top-level `Failures` node

### File

`extension.ts`

### Add types

Add near `TreeItemData`:

```ts
interface UsageFailureItem {
    label: string;
    description: string;
    reason: string;
    severity: 'warning' | 'error';
    normalizedKey?: string;
    count: number;
    totalNanoAiu: number;
    totalTokens: number;
    target: UsageRevealTarget;
}
```

Add to `TreeItemData` union:

```ts
| { kind: 'failures'; summary: SessionSummary }
| { kind: 'failureItem'; failure: UsageFailureItem; target: UsageRevealTarget }
```

### Add helper: `collectSessionFailures`

```ts
function collectSessionFailures(summary: SessionSummary): UsageFailureItem[] {
    const byKey = new Map<string, UsageFailureItem>();

    for (let msgIndex = 0; msgIndex < summary.userMessages.length; msgIndex++) {
        const msg = summary.userMessages[msgIndex];
        for (let turnIndex = 0; turnIndex < msg.modelTurns.length; turnIndex++) {
            const turn = msg.modelTurns[turnIndex];

            const failedToolCalls = turn.toolCalls.filter(tc => tc.failure?.isFailure);

            if (turn.failure?.isFailure && failedToolCalls.length === 0) {
                const target = targetFromDebugRef('modelTurn', turn.debugRef, {
                    messageIndex: msgIndex,
                    turnIndex,
                    label: turn.debugName,
                });
                if (target) {
                    addFailureToMap(byKey, {
                        label: turn.failure.normalizedKey || turn.failure.reason || `Message ${msgIndex + 1}, Turn ${turnIndex + 1}`,
                        description: `${formatAic(turn.nanoAiu)} AIC | ${formatNumber(turn.totalTokens)} tokens`,
                        reason: turn.failure.reason || 'Model turn failed',
                        severity: turn.failure.severity === 'error' ? 'error' : 'warning',
                        normalizedKey: turn.failure.normalizedKey,
                        count: 1,
                        totalNanoAiu: turn.nanoAiu,
                        totalTokens: turn.totalTokens,
                        target,
                    });
                }
            }

            for (const tc of failedToolCalls) {
                const target = targetFromDebugRef('turnToolCall', tc.debugRef, {
                    messageIndex: msgIndex,
                    turnIndex,
                    toolCallId: tc.toolCallId,
                    label: tc.displayLabel,
                });
                if (!target) { continue; }

                const key = tc.failure?.normalizedKey || `${tc.name}:${tc.displayLabel}`;
                addFailureToMap(byKey, {
                    label: key,
                    description: `${formatAic(turn.nanoAiu)} AIC | ${formatNumber(turn.totalTokens)} tokens`,
                    reason: tc.failure?.reason || 'Tool call failed',
                    severity: tc.failure?.severity === 'error' ? 'error' : 'warning',
                    normalizedKey: tc.failure?.normalizedKey,
                    count: 1,
                    totalNanoAiu: turn.nanoAiu,
                    totalTokens: turn.totalTokens,
                    target,
                });
            }
        }
    }

    return [...byKey.values()].sort(compareFailures);
}
```

### Add helper: `addFailureToMap`

```ts
function addFailureToMap(map: Map<string, UsageFailureItem>, item: UsageFailureItem): void {
    const key = item.normalizedKey || item.label;
    const existing = map.get(key);
    if (!existing) {
        map.set(key, item);
        return;
    }

    existing.count += item.count;
    existing.totalNanoAiu += item.totalNanoAiu;
    existing.totalTokens += item.totalTokens;

    // Keep the highest-cost item as the click target.
    if (item.totalNanoAiu > existing.totalNanoAiu) {
        existing.target = item.target;
    }

    existing.description = `${existing.count}x | ${formatAic(existing.totalNanoAiu)} AIC | ${formatNumber(existing.totalTokens)} tokens`;
}
```

### Add helper: `compareFailures`

```ts
function compareFailures(a: UsageFailureItem, b: UsageFailureItem): number {
    const severityScore = (f: UsageFailureItem) => f.severity === 'error' ? 1 : 0;
    const severityDelta = severityScore(b) - severityScore(a);
    if (severityDelta !== 0) { return severityDelta; }

    if (b.count !== a.count) { return b.count - a.count; }
    if (b.totalNanoAiu !== a.totalNanoAiu) { return b.totalNanoAiu - a.totalNanoAiu; }
    return b.totalTokens - a.totalTokens;
}
```

### Update `getChildren('session')`

Current `session` children build `stats`, add tip, add `insights`, and append messages.

Add failures before insights or immediately after tip:

```ts
const failures = collectSessionFailures(s);
if (failures.length > 0) {
    stats.push({ kind: 'failures', summary: s });
}
```

Recommended order:

1. Total Cost
2. Estimated USD
3. Enable Debug Logs if needed
4. Total Tokens
5. Total LLM Time
6. Model Turns / Tool Calls
7. Tip
8. Failures
9. Insights
10. Messages

### Add `getTreeItem('failures')`

```ts
case 'failures': {
    const failures = collectSessionFailures(element.summary);
    const totalAic = failures.reduce((s, f) => s + f.totalNanoAiu, 0);
    const item = new vscode.TreeItem('Failures / Wasted Attempts', vscode.TreeItemCollapsibleState.Expanded);
    item.description = `${failures.length} grouped | ${formatAic(totalAic)} AIC impacted`;
    item.iconPath = failures.some(f => f.severity === 'error') ? failureErrorIcon : failureWarningIcon;
    item.tooltip = 'Failed or suspicious turns grouped by normalized failure key. Expand to inspect likely token-waste hot spots.';
    item.contextValue = 'failuresGroup';
    return item;
}
```

### Add `getTreeItem('failureItem')`

```ts
case 'failureItem': {
    const f = element.failure;
    const label = f.count > 1 ? `${f.label} ×${f.count}` : f.label;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = f.description;
    item.iconPath = f.severity === 'error' ? failureErrorIcon : failureWarningIcon;
    item.tooltip = [
        f.reason,
        f.normalizedKey ? `Key: ${f.normalizedKey}` : undefined,
        `Count: ${f.count}`,
        `Impacted AIC: ${formatAic(f.totalNanoAiu)}`,
        `Impacted tokens: ${formatNumber(f.totalTokens)}`,
        'Click to reveal the best matching debug log row.',
    ].filter(Boolean).join('\n');
    item.contextValue = 'failureItem';
    attachRevealCommand(item, element);
    return item;
}
```

### Add `getChildren('failures')`

```ts
case 'failures': {
    return collectSessionFailures(element.summary).map(f => ({
        kind: 'failureItem' as const,
        failure: f,
        target: f.target,
    }));
}
```

---

## Phase 9: Update `SessionGraph` and `@usage` serialization

### File

`graph.ts`

### Extend graph interfaces

Add to `GraphTurn`:

```ts
failure?: {
    severity: 'info' | 'warning' | 'error';
    reason?: string;
    normalizedKey?: string;
};
```

Add to `GraphToolCall`:

```ts
status?: string;
failure?: {
    severity: 'info' | 'warning' | 'error';
    reason?: string;
    normalizedKey?: string;
};
```

Optional but useful: add `argsPreview?: string` or `resultPreview?: string`; do not add huge raw fields to LLM context.

### Update `buildGraphTurn`

```ts
failure: t.failure?.isFailure ? {
    severity: t.failure.severity,
    reason: t.failure.reason,
    normalizedKey: t.failure.normalizedKey,
} : undefined,
```

For each tool call:

```ts
status: tc.status,
failure: tc.failure?.isFailure ? {
    severity: tc.failure.severity,
    reason: tc.failure.reason,
    normalizedKey: tc.failure.normalizedKey,
} : undefined,
```

### Add graph failure getter

Add interface:

```ts
export interface FailureEntry {
    messageIndex: number;
    turnIndex: number;
    toolCall?: string;
    reason: string;
    normalizedKey?: string;
    severity: 'warning' | 'error';
    costAic: number;
    tokens: number;
}
```

Add private cache:

```ts
private _failures?: FailureEntry[];
```

Add getter:

```ts
get failures(): FailureEntry[] {
    if (!this._failures) {
        this._failures = this.computeFailures();
    }
    return this._failures;
}
```

Add method:

```ts
private computeFailures(): FailureEntry[] {
    const failures: FailureEntry[] = [];
    for (const msg of this.messages) {
        for (const turn of msg.turns) {
            if (turn.failure) {
                failures.push({
                    messageIndex: msg.index,
                    turnIndex: turn.index,
                    reason: turn.failure.reason || turn.failure.normalizedKey || 'Turn failed',
                    normalizedKey: turn.failure.normalizedKey,
                    severity: turn.failure.severity === 'error' ? 'error' : 'warning',
                    costAic: turn.costAic,
                    tokens: turn.inputTokens + turn.outputTokens,
                });
            }
            for (const tc of turn.toolCalls) {
                if (tc.failure) {
                    failures.push({
                        messageIndex: msg.index,
                        turnIndex: turn.index,
                        toolCall: tc.displayLabel,
                        reason: tc.failure.reason || tc.failure.normalizedKey || 'Tool call failed',
                        normalizedKey: tc.failure.normalizedKey,
                        severity: tc.failure.severity === 'error' ? 'error' : 'warning',
                        costAic: turn.costAic,
                        tokens: turn.inputTokens + turn.outputTokens,
                    });
                }
            }
        }
    }
    return failures.sort((a, b) => {
        const sev = (b.severity === 'error' ? 1 : 0) - (a.severity === 'error' ? 1 : 0);
        if (sev !== 0) { return sev; }
        return b.costAic - a.costAic;
    });
}
```

### Update `serialize()`

After `## Commands` and before `## Risk Flags`, add:

```ts
if (this.failures.length > 0) {
    lines.push('## Failures / Wasted Attempts');
    for (const f of this.failures.slice(0, 20)) {
        const tool = f.toolCall ? ` | ${f.toolCall}` : '';
        const key = f.normalizedKey ? ` | key:${f.normalizedKey}` : '';
        lines.push(`  [${f.severity}] Message ${f.messageIndex + 1}, Turn ${f.turnIndex + 1}: ${f.reason}${key} | ${f.costAic.toFixed(1)} AIC | ${formatNumber(f.tokens)} tokens${tool}`);
    }
    if (this.failures.length > 20) {
        lines.push(`  ... ${this.failures.length - 20} more failures`);
    }
    lines.push('');
}
```

### Keep `computeRisks()` separate

Do not remove `computeRisks()`. Failures are not the same as risky operations:

- Risk: dangerous or notable action, even if successful.
- Failure: action likely wasted tokens/credits or time because it failed.

---

## Phase 10: Tests / validation

If the repo already has tests, add proper tests. If not, add fixture-based validation scripts or manually validate through Extension Development Host.

### Parser test cases

Create a small `main.jsonl` fixture containing:

1. A `user_message`.
2. An `llm_request` with token and AIC fields.
3. A `tool_call` named `run_in_terminal` with args `{ "command": "rg foo" }`.
4. The tool result containing one of:
   - `The term 'rg' is not recognized as the name of a cmdlet`
   - `command not found: rg`
   - `exit code 9009`

Expected parser output:

- `summary.userMessages[0].modelTurns[0].toolCalls[0].failure.isFailure === true`
- `normalizedKey === 'missing-command:rg'`
- containing turn has `failure.isFailure === true`
- containing message has `failure.isFailure === true`
- `debugRef.sourceFile` exists
- `debugRef.sourceLine` is the expected JSONL line number

### Non-failure test

Fixture with `run_in_terminal` using `rg foo` but result is normal successful output.

Expected:

- no tool failure
- no turn failure
- no message failure

### Timestamp fallback test

Fixture where no `spanId`, `responseId`, or `toolCallId` matches but timestamp is close.

Expected:

- `findBestLineInJsonl()` returns the closest timestamp line within 10 seconds.

### Usage tree manual validation

Run Extension Development Host:

1. Load the extension.
2. Open `COPILOT USAGE: TOKEN USAGE`.
3. Pick a session with a known failed `rg` attempt.
4. Confirm failed message/turn/tool nodes show an error or warning icon.
5. Confirm a top-level `Failures / Wasted Attempts` node appears.
6. Expand it and confirm repeated `missing-command:rg` failures are grouped.
7. Click the failure item.
8. Confirm the raw debug JSONL opens at the best matching line.

### Compile commands

Run whichever commands already exist in `package.json`. Likely:

```bash
npm install
npm run compile
npm test
```

If no tests exist, at minimum run:

```bash
npm run compile
```

Do not add new dependencies for this feature unless absolutely necessary.

---

## Acceptance criteria

The implementation is complete when all of these are true:

- Usage tree `userMessage`, `modelTurn`, `turnToolCall`, `mergedItem`, and `failureItem` nodes have a reveal command when they have provenance data.
- Clicking a Usage node opens the matching source JSONL line if direct Agent Debug Logs tree selection is not available.
- Matching uses this priority:
  1. `toolCallId`
  2. `responseId`
  3. `spanId`
  4. `parentSpanId`
  5. `sourceLine`
  6. closest timestamp within 10 seconds
- Failed tool calls show an error/warning icon.
- Failed model turns show an error/warning icon and `FAILED |` in the description.
- User messages containing failed turns show an inherited warning/error icon.
- A top-level `Failures / Wasted Attempts` node appears when failures exist.
- Repeated missing-command failures such as `missing-command:rg` are grouped and sorted above lower-cost single failures.
- `@usage` serialized graph output includes a `Failures / Wasted Attempts` section.
- Existing spend summary, session picker, and session auto-load behavior still work.
- Existing risky operation detection in `SessionGraph.computeRisks()` still works.

---

## Non-goals for this implementation

Do not implement these unless explicitly requested later:

- Full arbitrary tree item text color styling.
- A webview-based custom tree replacement.
- A full Agent Debug Logs clone panel unless external panel selection is impossible and product direction chooses to own that UI.
- New package dependencies.
- Broad parser rewrites.
- Remote telemetry.
- Automatic installation of `rg` or any missing command.

---

## Suggested commit breakdown

1. `parser: preserve debug source refs and raw tool status fields`
2. `parser: classify failed tool calls and turns`
3. `usage-tree: add reveal target command and raw log fallback`
4. `usage-tree: highlight failed turns and add failures group`
5. `graph: serialize failures for usage chat participant`
6. `tests: add missing rg failure fixture`

---

## Notes for older LLM implementer

- Make one small change at a time and compile frequently.
- Do not change public behavior unrelated to this task.
- Keep all new fields optional so old parsed data does not break.
- Prefer helper functions over duplicating mapping logic.
- Do not trust `spanId` alone; parser comments already warn that span IDs may be recycled across messages. Always keep timestamp fallback.
- Prefer `args.command` over `displayLabel` for terminal command detection because display labels may be truncated.
- If a compile error says a union member does not exist, add the `TreeItemData` union member before referencing it.
- If a compile error says a property does not exist on a parser type, verify the interface in `parser.ts` has the optional field.
- If source lines are off by one, check whether blank lines were filtered before counting. The debug-log parser must not use `.filter(l => l.trim())` before assigning source lines.
