/**
 * Two LM tools for querying Copilot usage data:
 *
 * 1. usage-search-sessions — Find sessions by keyword/date range. Returns titles + IDs.
 * 2. usage-get-graph — Get full session graph (messages, turns, tool calls, commands, costs).
 *    The LLM interprets the data itself (no preset heuristics).
 */

import * as vscode from 'vscode';
import { SessionSummary, parseCopilotSessionLog } from './parser';
import { SessionGraph } from './graph';

// ---- Shared state ----

let currentGraph: SessionGraph | undefined;
const loadedGraphs = new Map<string, SessionGraph>();

type SessionFinder = () => { id: string; mainJsonl: string; modifiedTime: number }[];
type TitleResolver = (id: string) => string | undefined;

let sessionFinder: SessionFinder = () => [];
let titleResolver: TitleResolver = () => undefined;

export function setCurrentGraph(summary: SessionSummary): void {
    const graph = new SessionGraph(summary);
    currentGraph = graph;
    loadedGraphs.set(summary.sessionId, graph);
}

export function getCurrentGraph(): SessionGraph | undefined {
    return currentGraph;
}

// ---- Tool 1: Search Sessions ----

interface SearchInput {
    query?: string;
    daysBack?: number;
    limit?: number;
}

class SearchSessionsTool implements vscode.LanguageModelTool<SearchInput> {
    invoke(options: vscode.LanguageModelToolInvocationOptions<SearchInput>): vscode.ProviderResult<vscode.LanguageModelToolResult> {
        const { query, daysBack = 3, limit = 25 } = options.input;

        const sessions = sessionFinder();
        const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
        const twoDayCutoff = Date.now() - (2 * 24 * 60 * 60 * 1000);

        // Always include last 2 days as safety net
        const recentSessions = sessions.filter(s => s.modifiedTime >= twoDayCutoff);
        let searchResults = sessions.filter(s => s.modifiedTime >= cutoff);

        if (query) {
            // Split query into words — each word is an OR wildcard match
            const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
            searchResults = searchResults.filter(s => {
                const title = (titleResolver(s.id) || '').toLowerCase();
                const idLower = s.id.toLowerCase();
                // Match if ANY word appears in title or id (OR logic, like wildcard)
                return words.some(w => title.includes(w) || idLower.includes(w));
            });
        }

        // Merge: search results + recent sessions (deduped), search results first
        const seen = new Set<string>();
        const merged: typeof sessions = [];
        for (const s of searchResults) {
            if (!seen.has(s.id)) { seen.add(s.id); merged.push(s); }
        }
        for (const s of recentSessions) {
            if (!seen.has(s.id)) { seen.add(s.id); merged.push(s); }
        }

        const results = merged.slice(0, limit).map(s => {
            const title = titleResolver(s.id);
            const date = new Date(s.modifiedTime).toLocaleString();
            const isCurrent = currentGraph?.stats.sessionId === s.id;
            return `${isCurrent ? '→ [LOADED] ' : '  '}${title || s.id.slice(0, 8) + '...'} | ${date} | id:${s.id}`;
        });

        const currentLabel = currentGraph
            ? `Currently loaded in Usage panel: "${currentGraph.stats.title || currentGraph.stats.sessionId}"\n`
            : '';

        const text = results.length === 0
            ? `${currentLabel}No sessions found${query ? ` matching "${query}"` : ''} in the last ${daysBack} days.`
            : `${currentLabel}Found ${results.length} session(s):\n${results.join('\n')}`;

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }

    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SearchInput>): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Searching sessions${options.input.query ? `: "${options.input.query}"` : ''}...` };
    }
}

// ---- Tool 2: Get Session Graph ----

interface GetGraphInput {
    sessionId?: string;
    includeMessages?: boolean;
    maxMessages?: number;
}

class GetGraphTool implements vscode.LanguageModelTool<GetGraphInput> {
    invoke(options: vscode.LanguageModelToolInvocationOptions<GetGraphInput>): vscode.ProviderResult<vscode.LanguageModelToolResult> {
        const { sessionId, includeMessages = true, maxMessages = 50 } = options.input;

        let graph: SessionGraph | undefined;

        if (sessionId) {
            // Try exact match, then prefix match, then load from disk
            graph = loadedGraphs.get(sessionId);
            if (!graph) {
                for (const [id, g] of loadedGraphs) {
                    if (id.startsWith(sessionId)) { graph = g; break; }
                }
            }
            if (!graph) {
                const sessions = sessionFinder();
                const match = sessions.find(s => s.id === sessionId || s.id.startsWith(sessionId));
                if (match) {
                    const summary = parseCopilotSessionLog(match.mainJsonl);
                    if (summary) {
                        summary.title = titleResolver(summary.sessionId);
                        graph = new SessionGraph(summary);
                        loadedGraphs.set(summary.sessionId, graph);
                    }
                }
            }
        } else {
            graph = currentGraph;
        }

        if (!graph) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No session found. Use usage-search-sessions to find session IDs first.'),
            ]);
        }

        // Return the full graph — let the LLM interpret what's relevant
        const text = graph.serialize({ includeMessages, maxMessages });
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }

    prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return { invocationMessage: 'Loading session graph...' };
    }
}

// ---- Chat participant ----

function buildSystemPrompt(): string {
    const currentInfo = currentGraph
        ? `Currently loaded session: "${currentGraph.stats.title || currentGraph.stats.sessionId}" (id: ${currentGraph.stats.sessionId})`
        : 'No session currently loaded in the Usage panel.';

    return `You are a Copilot usage analyzer. You help users understand their chat session costs, tool usage, and potential issues.

${currentInfo}

You have 2 tools:
- usage-search-sessions: Search recent chat sessions by keyword. Returns titles, dates, and IDs. Also always includes the last 2 days of sessions as context.
- usage-get-graph: Get full session data (messages, turns, tool calls, commands, costs).

IMPORTANT RULES:
1. If the user says "this session", "current session", "this chat", or "the loaded one" — call usage-get-graph WITHOUT a sessionId to get the currently loaded session.
2. For ANY other request (e.g. "the vscode plugin chat", "yesterday's chat about X") — ALWAYS call usage-search-sessions FIRST to find the right session ID, then call usage-get-graph with that ID.
3. NEVER guess which session the user means. Search first if there's any ambiguity.
4. You can chain tool calls: search → find ID → get graph → analyze. Do this in sequence.
5. When analyzing, look at the raw data yourself for risks, waste, patterns, or anything the user asks about.`;
}


async function handleRequest(
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    if (!currentGraph && loadedGraphs.size === 0) {
        stream.markdown('No session data available. Load a session first using the **Copilot Usage** panel (dashboard icon in the activity bar).');
        return {};
    }

    const registeredTools = vscode.lm.tools.filter(t => t.name.startsWith('usage-'));
    const tools: vscode.LanguageModelChatTool[] = registeredTools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
    }));

    let model = request.model;
    if (model.vendor === 'copilot' && model.family.startsWith('o1')) {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
        if (models.length > 0) { model = models[0]; }
    }

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(buildSystemPrompt()),
        vscode.LanguageModelChatMessage.User(request.prompt),
    ];

    const options: vscode.LanguageModelChatRequestOptions = {
        justification: 'To analyze Copilot usage data',
        tools,
    };

    const toolReferences = [...request.toolReferences];

    const runWithTools = async (): Promise<void> => {
        const requestedTool = toolReferences.shift();
        if (requestedTool) {
            options.toolMode = vscode.LanguageModelChatToolMode.Required;
            options.tools = tools.filter(t => t.name === requestedTool.name);
        } else {
            options.toolMode = undefined;
            options.tools = tools;
        }

        const response = await model.sendRequest(messages, options, token);

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                stream.markdown(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }

        if (toolCalls.length) {
            messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));

            for (const call of toolCalls) {
                let result: vscode.LanguageModelToolResult;
                try {
                    result = await vscode.lm.invokeTool(call.name, {
                        input: call.input,
                        toolInvocationToken: request.toolInvocationToken,
                    }, token);
                } catch (e: any) {
                    result = new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Tool error: ${e.message}`),
                    ]);
                }
                messages.push(vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart(call.callId, result.content),
                ]));
            }

            return runWithTools();
        }
    };

    try {
        await runWithTools();
    } catch (e: any) {
        if (e.message?.includes('off_topic')) {
            stream.markdown('I can only help with Copilot usage analysis.');
        } else {
            stream.markdown(`Error: ${e.message || 'Request failed.'}`);
        }
    }

    return {};
}

// ---- Registration ----

export function registerChatParticipant(
    context: vscode.ExtensionContext,
    findSessions: SessionFinder,
    resolveTitle: TitleResolver
): void {
    sessionFinder = findSessions;
    titleResolver = resolveTitle;

    // Register tools (IDs must match /^[\w-]+$/ — no dots!)
    context.subscriptions.push(
        vscode.lm.registerTool('usage-search-sessions', new SearchSessionsTool()),
        vscode.lm.registerTool('usage-get-graph', new GetGraphTool()),
    );

    // Chat participant
    const participant = vscode.chat.createChatParticipant('copilot-usage-tracker.usage', handleRequest);
    participant.iconPath = new vscode.ThemeIcon('dashboard');
    context.subscriptions.push(participant);
}
