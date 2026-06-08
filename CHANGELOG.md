# Changelog

## 0.6.0

- Adds a central user-level Spend Summary cache shared across workspaces.
- Reuses parsed spend data for unchanged chat-session files based on file mtime and size.
- Parses snake_case chat-session usage token fields.
- Invalidates stale Spend Summary file-cache entries when parser behavior changes.
- Counts direct `nanoAiu` usage fields and token-only usage rows in Spend Summary totals.
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
