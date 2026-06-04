# Changelog

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
