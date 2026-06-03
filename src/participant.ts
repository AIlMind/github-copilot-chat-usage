/**
 * Two LM tools for querying Copilot usage data:
 *
 * 1. usage-search-sessions - Find sessions by keyword/date range. Returns titles + IDs.
 * 2. usage-get-graph - Get full session graph (messages, turns, tool calls, commands, costs).
 *    The LLM interprets the data itself (no preset heuristics).
 */

import * as vscode from 'vscode';
import { SessionSummary, parseCopilotSessionLog } from './parser';
import { SessionGraph } from './graph';

// ---- Shared state ----

let currentGraph: SessionGraph | undefined;
const loadedGraphs = new Map<string, SessionGraph>();

type SessionFinder = () => {
  id: string;
  mainJsonl: string;
  modifiedTime: number;
}[];

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
  limit?: number;
  daysBack?: number;
}

class SearchSessionsTool
  implements vscode.LanguageModelTool<SearchInput>
{
  invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchInput>
  ): vscode.ProviderResult<vscode.LanguageModelToolResult> {

    const { query, limit = 25, daysBack = 3 } = options.input;

    const sessions = sessionFinder();
    const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const twoDayCutoff = Date.now() - (2 * 24 * 60 * 60 * 1000);

    // Always include last 2 days as safety net
    const recentSessions =
      sessions.filter(s => s.modifiedTime >= twoDayCutoff);

    let searchResults =
      sessions.filter(s => s.modifiedTime >= cutoff);

    if (query) {
      // Split query into words - each word is an OR wildcard match
      const words = query.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 0);

      searchResults = searchResults.filter(s => {
        const title =
          (titleResolver(s.id) || '').toLowerCase();

        const idLower = s.id.toLowerCase();

        // Match if ANY word appears in title or id
        return words.some(
          w => title.includes(w) || idLower.includes(w)
        );
      });
    }

    // Merge: search results + recent sessions (deduped),
    // search results first
    const seen = new Set<string>();
    const merged: typeof sessions = [];

    for (const s of searchResults) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        merged.push(s);
      }
    }

    for (const s of recentSessions) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        merged.push(s);
      }
    }

    const results = merged.slice(0, limit).map(s => {
      const title = titleResolver(s.id);
      const date = new Date(s.modifiedTime).toLocaleString();
      const isCurrent =
        currentGraph?.stats.sessionId === s.id;

      return `${isCurrent ? '* [LOADED] ' : ''}${
        title || s.id.slice(0, 8) + '...'
      } | ${date} | id:${s.id}`;
    });

    const currentLabel = currentGraph
      ? `Currently loaded in Usage panel: "${
          currentGraph.stats.title ||
          currentGraph.stats.sessionId
        }"\n`
      : '';

    const text =
      results.length === 0
        ? `${currentLabel}No sessions found${
            query ? ` matching "${query}"` : ''
          } in the last ${daysBack} days.`
        : `${currentLabel}Found ${results.length} session(s):\n${
            results.join('\n')
          }`;

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<SearchInput>
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return {
      invocationMessage:
        `Searching sessions${
          options.input.query
            ? `: "${options.input.query}"`
            : ''
        }...`,
    };
  }
}

// ---- Tool 2: Get Session Graph ----

interface GetGraphInput {
  sessionId?: string;
  includeMessages?: boolean;
  maxMessages?: number;
}

class GetGraphTool
  implements vscode.LanguageModelTool<GetGraphInput>
{
  invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetGraphInput>
  ): vscode.ProviderResult<vscode.LanguageModelToolResult> {

    const { sessionId, includeMessages = true, maxMessages = 50 } = options.input;

    let graph: SessionGraph | undefined;

    if (sessionId) {
      // Try exact match, then prefix match, then load from disk
      graph = loadedGraphs.get(sessionId);

      if (!graph) {
        for (const [id, g] of loadedGraphs) {
          if (id.startsWith(sessionId)) {
            graph = g;
            break;
          }
        }
      }

      if (!graph) {
        const sessions = sessionFinder();

        const match = sessions.find(
          s => s.id === sessionId ||
               s.id.startsWith(sessionId)
        );

        if (match) {
          const summary =
            parseCopilotSessionLog(match.mainJsonl);

          if (summary) {
            summary.title =
              titleResolver(summary.sessionId);

            graph = new SessionGraph(summary);
            loadedGraphs.set(
              summary.sessionId,
              graph
            );
          }
        }
      }
    } else {
      graph = currentGraph;
    }

    if (!graph) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No session found. Use usage-search-sessions to find session IDs first.'
        ),
      ]);
    }

    // Return full graph - let the LLM interpret it
    const text = graph.serialize({
      includeMessages,
      maxMessages,
    });

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }

  prepareInvocation(): vscode.ProviderResult<
    vscode.PreparedToolInvocation
  > {
    return {
      invocationMessage: 'Loading session graph...',
    };
  }
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  findSessions: SessionFinder,
  resolveTitle: TitleResolver
): void {
  sessionFinder = findSessions;
  titleResolver = resolveTitle;

  context.subscriptions.push(
    vscode.lm.registerTool('usage-search-sessions', new SearchSessionsTool()),
    vscode.lm.registerTool('usage-get-graph', new GetGraphTool())
  );

  const participant = vscode.chat.createChatParticipant(
    'copilot-usage-tracker.usage',
    (request, _context, response) => {
      const graph = currentGraph;
      if (!graph) {
        response.markdown('No Copilot usage session is loaded yet. Run **Copilot Usage: Load Most Recent Session** first.');
        return;
      }

      const prompt = request.prompt.toLowerCase();
      if (prompt.includes('risk')) {
        const risks = graph.risks;
        response.markdown(
          risks.length
            ? risks.map(r => `- [${r.severity}] Message ${r.messageIndex + 1}, Turn ${r.turnIndex + 1}: ${r.reason} (${r.toolCall})`).join('\n')
            : 'No risky operations were detected in the loaded session.'
        );
        return;
      }

      if (prompt.includes('command') || prompt.includes('terminal')) {
        const commands = graph.commands;
        response.markdown(
          commands.length
            ? commands.map(c => `- ${c.executable}: ${c.count}`).join('\n')
            : 'No terminal commands were detected in the loaded session.'
        );
        return;
      }

      if (prompt.includes('tool')) {
        const tools = graph.getToolsByUsage();
        response.markdown(
          tools.length
            ? tools.map(t => `- ${t.name}: ${t.count} (${t.tier})`).join('\n')
            : 'No tool calls were detected in the loaded session.'
        );
        return;
      }

      response.markdown(graph.serialize({ includeMessages: true, maxMessages: 20 }));
    }
  );

  context.subscriptions.push(participant);
}
