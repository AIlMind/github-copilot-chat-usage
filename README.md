# Copilot Usage Tracker

A local VS Code extension that indexes Copilot/VS Code chat debug logs and turns them into a compact usage graph: cost, token totals, cache hit ratio, tool calls, terminal commands, and risky command flags.

## What this zip contains

This is a best-effort recreated extension project. The recovered `src/graph.ts` file is included as source. The surrounding files (`parser.ts`, `extension.ts`, `participant.ts`, manifest, and tests) are compatible replacements written to make the project recreatable.

## Commands

- `Copilot Usage: Load Most Recent Session`
- `Copilot Usage: Load Session From File`
- `Copilot Usage: Search Sessions`
- `Copilot Usage: Show Current Summary`

The extension also contributes a chat participant:

```text
@usage summarize the current session
@usage show risks
@usage show tools
@usage show commands
```

And two language model tools:

- `copilot_usage_searchSessions`
- `copilot_usage_getGraph`

## Build and run

```bash
npm install
npm run compile
npm test
```

Then open the folder in VS Code and press `F5` to launch an Extension Development Host.

To package a `.vsix`:

```bash
npm run package
```

## Log discovery

The extension searches common VS Code folders on macOS, Windows, and Linux, including Code / Code Insiders log and workspace storage directories. You can add extra roots in settings:

```json
{
  "copilotUsageTracker.searchRoots": [
    "/absolute/path/to/logs"
  ]
}
```

The parser is deliberately tolerant: it handles JSONL-style logs with many possible field names (`sessionId`, `sid`, `inputTokens`, `prompt_tokens`, `toolCalls`, `toolName`, `durationMs`, and so on). If your local Copilot debug log schema differs, adjust `src/parser.ts` in one place.

## Completeness verdict

This zip should be enough to recreate and iterate on the plugin as a VS Code extension project, but it is not guaranteed to be a byte-for-byte copy of the original screenshot source. See `RECOVERY_NOTES.md` for exact confidence notes.
