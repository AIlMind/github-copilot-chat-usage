# GitHub Copilot Chat Usage

A local VS Code extension for inspecting GitHub Copilot Chat usage from VS Code's persisted chat/debug logs.

It builds a session view with message counts, token totals, AIC totals, tool calls, terminal command summaries, cache ratios, and an `@usage` chat participant for asking questions about the loaded session.

This project is not affiliated with GitHub, Microsoft, or the GitHub Copilot team.

## Features

- Auto-load the most recent Copilot Chat session.
- Pick a previous session from local VS Code workspace storage.
- Show message, model-turn, token, cache, duration, and AIC totals.
- Show tool calls from debug logs and VS Code `chatSessions` history.
- Summarize terminal command usage and potentially risky shell commands.
- Ask `@usage` questions about the currently loaded session or recent sessions.

## Requirements

To get cost/token data, enable Copilot Chat debug log file logging in VS Code:

1. Open Settings.
2. Search for `github.copilot.chat.agentDebugLog.fileLogging.enabled`.
3. Set it to `true`.
4. Start a new Copilot Chat session.
5. Run `Copilot Usage: Analyze Current Session` or use the Copilot Usage activity bar view.

The extension can also read VS Code `chatSessions` files for transcript/tool-call information when debug logs are missing or incomplete. Those files do not always contain billing totals.

## Privacy

This extension reads local VS Code/Copilot Chat storage files from your machine. It does not upload data by itself.

When you use the `@usage` chat participant, the extension sends the selected session summary to the VS Code language model you are using so it can answer your question. Session summaries may include message previews, tool names, terminal command summaries, token counts, and cost totals.

## Commands

- `Copilot Usage: Analyze Current Session`
- `Copilot Usage: Pick Session to Analyze`
- `Refresh`

## Chat Participant

Use the chat participant in Copilot Chat:

```text
@usage summarize this session
@usage show tool usage
@usage find risky commands
@usage compare recent sessions about parser changes
```

The extension contributes two language model tools for the participant:

- `usage-search-sessions`
- `usage-get-graph`

## Build

```bash
npm install
npm run compile
npm test
```

## Package

```bash
npm run package
```

This creates a `.vsix` file that can be installed locally:

```bash
code --install-extension github-copilot-chat-usage-0.1.0.vsix
```

## Notes

VS Code and Copilot Chat log formats are not public stable APIs. The parser is intentionally tolerant, but some values are best-effort and may need updates if VS Code changes its persisted chat or debug-log schema.
