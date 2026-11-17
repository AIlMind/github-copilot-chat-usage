# GitHub Copilot Chat Usage

GitHub Copilot Chat Usage is a lightweight VS Code extension for understanding where your Copilot Chat spend goes. It reads local VS Code Copilot Chat logs and shows cost, token, and tool-call breakdowns by conversation message.

This extension is not affiliated with GitHub or Microsoft.

GitHub documents Copilot usage in AI credits, where "1 AI credit = $0.01 USD" in the official [GitHub Copilot billing docs](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing).

![GitHub Copilot Chat Usage showing token, cost, and tool-call insights](https://ailmind.com/images/copilot-usage-screenshot.png)

## Features

- See AIC, token, cache, model-turn, and duration totals for each message.
- Inspect normal input, cache reads, cache writes, output, and recorded token costs for each model call.
- Expand main-agent and subagent branches, Fusion routing decisions, and permission-check diagnostics. Compare recorded Auto rates with matching standard rates without discounting the charge again.
- Inspect built-in tool calls such as searches, file reads, edits, diagnostics, todos, and terminal commands.
- Use `@usage` in Copilot Chat to ask AI questions about the currently loaded session or recent sessions.
- Open the GitHub AI credits documentation directly from the AIC row.
- Automatic updates run at most once every 30 seconds while logs change. Existing totals stay visible; use **Refresh** for an immediate update.

## Setup

Background-agent usage is read automatically from saved local records. For detailed local-chat logs, set this VS Code setting to `true`:

```text
github.copilot.chat.agentDebugLog.fileLogging.enabled
```

Then start a new Copilot Chat session and open the Copilot Usage activity bar view.

The extension can also read VS Code `chatSessions` files for transcript and tool-call information when debug logs are missing or incomplete. Those files do not always contain billing totals.

## Privacy

This extension reads local VS Code/Copilot Chat storage files from your machine. It does not upload data by itself.

When you use the `@usage` chat participant, the extension sends the selected session summary to the VS Code language model you are using so it can answer your question. Session summaries may include message previews, tool names, terminal command summaries, token counts, and cost totals.

## Commands

- `Copilot Usage: Analyze Current Session`
- `Copilot Usage: Pick Session to Analyze`
- `Refresh`

## Build

```bash
npm install
npm run compile
npm test
```

## Notes

VS Code and Copilot Chat log formats are not public stable APIs. The parser is intentionally tolerant, but some values are best-effort and may need updates if VS Code changes its persisted chat or debug-log schema.

## Background agents

Background sessions are discovered alongside local chat sessions. The extension reads saved agent `session.db` usage and Copilot SDK session metadata, including stores under `COPILOT_HOME`. Workspace, global, profile, and active custom VS Code storage paths are included automatically. Additional accessible stores can be added through `copilotUsageTracker.searchRoots`.

The session view and cumulative spend use recorded consumption totals where available. Context-window gauges are excluded from cumulative input tokens. Background model calls retain their timing, token detail, and subagent attribution. Saved inclusive turn totals fill gaps without counting calls twice. See the coverage notes below for how incomplete or undated usage affects totals.

Run `npm run audit:coverage` to compare local Copilot call logs, saved VS Code turns, and the SDK usage index. The audit reports coverage gaps; cloud-only and inaccessible remote sessions remain outside the local scanner.

## Usage coverage and billing

The figures come from saved local usage. GitHub's billing dashboard is the authority for charges. USD values are estimates at **1 AI credit = $0.01 USD** ([GitHub billing documentation](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)).

- **Per-message totals:** saved agent turns already include subagent usage. Individual calls remain separate. When only aggregate usage was saved, it is labelled accordingly; missing timing and context display “Not saved”. Session totals equal the sum of the displayed message rows, including any unattributed saved usage.
- **Today, 7 days and 30 days:** dated calls and saved turns are included. Timestamped cumulative checkpoints can recover missing credits. A checkpoint interval is included only when the entire interval falls inside the period; a gap crossing midnight cannot be assigned precisely to either day. Undated remainders remain in the session total.
- **Model costs:** recorded credits already include any applied discount. When a saved turn has multiple models but no per-model credits, the breakdown estimates each share from remaining input/output tokens and marks it with “≈”. The prompt total stays unchanged. Unattributed credits appear separately from models.
- **Permission checks:** call attempts, failures and explicit retries are diagnostic metadata. They do not create additional billing rows.
- **Timing:** recorded model, tool and hook durations may overlap; their sum is not elapsed session time. Cache expiration comes from the log, not a fixed TTL.
- **Tokens:** context-window gauges are excluded from cumulative consumption. Older logs may contain credits without token totals.
- **Coverage:** missing, unreadable or incomplete records can make totals lower than actual usage. Zero recorded usage does not establish that a session was free. Unsaved calls and inaccessible remote/cloud-only sessions cannot be recovered locally.

Session-specific diagnostics remain available through `@usage` and `npm run audit:coverage`.

Background usage is grouped with the matching workspace when a working directory is recorded. Model aliases share a spend row. Prompts show model switches and separate subagents; routing signals report what was recorded without assuming a particular orchestration strategy. Growing SDK logs are read incrementally with a bounded in-memory metadata cache.
