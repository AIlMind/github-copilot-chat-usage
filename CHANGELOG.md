# Changelog

## 0.8.5

- Fix checkpoint double counting during long-running prompts and attribute queued-message calls through their event ancestry.
- Recover permission-check token counts from response chunks while continuing to exclude frustration-classifier calls.
- Remove savings/list-price comparisons. Split aggregate model breakdowns with explicit estimate markers, format model names, and separate unattributed credits.
- Load recent sessions before indexing full history; reuse compatible same-day totals while validating, skip old/known-empty sources, and normalize Windows cache paths.
- Avoid temporary copies for stable rollback-mode databases without sidecars. Keep snapshots for WAL databases and retry changing sources.

## 0.8.4

- Attribute background usage to the matching workspace, including Windows file URIs and multi-root workspaces; keep sibling worktrees separate.
- Merge model aliases in spend summaries and show model mixes, prompt switches, subagent models and routing evidence.
- Read resumed/configured model selections, saved routing, nested accounting snapshots and permission-success/retry variants. Show permission tokens without adding billing.
- Parse only newly appended SDK log data and keep a bounded metadata cache; discard tool output, attachments and model prompts. Retry torn tails and reset on file replacement.

## 0.8.3

- Show missing token counts as Not saved and partial totals as recorded, including credit-only background history and spend summaries. Preserve recorded zero counts.

## 0.8.2

- Limit automatic session and spend updates to once every 30 seconds while logs change; manual Refresh remains immediate.
- Keep the last totals visible during updates, including zero values. Show a loading indicator only before data is available.
- Preserve individual background model calls, timing, TTFT, cache writes, token costs, reasoning and context diagnostics.
- Reconcile saved turn remainders and timestamped checkpoints without discarding calls or using stale shutdown totals. Keep message and session totals consistent.
- Add main/subagent branches, Fusion routing details, measured rate comparisons, permission-check diagnostics, and first-prompt picker titles.
- Filter empty agent stores from the picker; show missing metrics and interrupted tools explicitly.
- Share unchanged identity metadata across windows, merge concurrent spend caches, and retain the last readable usage while a database is busy.
- Move long usage coverage explanations from the panel to the Marketplace README.


## 0.8.1

- Fix hangs with large agent histories by indexing SDK session identities once per scan, including sessions without an SDK ID.
- Run discovery, parsing, spend scans, and chat-tool lookups in a worker so Copilot and other extensions stay responsive.
- Reuse unchanged spend data without invalidating the cache on SQLite metadata changes. Read temporary database/WAL snapshots without modifying live agent files.
- Recover loading indicators after failed scans and coalesce repeated refresh requests.


## 0.8.0

- Tracks Copilot background sessions and Fusion subagents from current VS Code and SDK storage.
- Resolves visible VS Code session ids to their SDK backing sessions.
- Reconciles cumulative totals with recorded per-call and saved turn usage without counting child usage twice.
- Refreshes usage when child logs, sidecars, or SQLite WAL files change.
- Explains missing or undated usage and excludes context-window gauges from consumed input tokens.
- Adds a local coverage audit and improves incremental parsing and cache invalidation.

## 0.6.0

- Adds a central user-level Spend Summary cache shared across workspaces.
- Reuses parsed spend data for unchanged chat-session files based on file mtime and size.
- Parses snake_case chat-session usage token fields.
- Invalidates stale Spend Summary file-cache entries when parser behavior changes.
- Counts direct `nanoAiu` usage fields and token-only usage rows in Spend Summary totals.
- Deduplicates copied fork requests in Spend Summary using stable response IDs.
- Includes nested subagent messages and turns in the `@usage` session graph tool output.
- Includes nested subagent tool calls in `@usage` graph tool usage and command counts.
- Uses the VS Code UI language for displayed datetimes.

## 0.5.0

- Adds workspace breakdowns to Spend Summary.
- Groups Spend Summary details into Workspace Summary and Models sections.
- Improves subagent parsing, including nested child sessions and in-progress subagents.
- Handles appended chat-session request patches more reliably.
- Avoids counting timestampless spend records as today's spend.

## 0.4.0

- Adds a Spend Summary section.

## 0.2.0

- Improves startup time by loading the current workspace session before scanning older workspace history.
- Speeds up session search by loading recent sessions first instead of reading all historical chat files up front.
- Adds a loading state for the session picker so it cannot be clicked repeatedly while sessions are loading.
- Adds a "Load older sessions" picker row to fetch older sessions in 10-day batches.

## 0.1.0

- Initial private release.
- Adds a VS Code tree view for Copilot Chat usage sessions.
- Parses Copilot debug logs and VS Code `chatSessions` files.
- Shows message, token, cache, AIC, model-turn, tool-call, and command summaries.
- Adds the `@usage` chat participant and usage graph language model tools.
