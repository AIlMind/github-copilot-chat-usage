# Recovery Notes

## Status

This project is complete enough to recreate a working VS Code extension project, but it is not a guaranteed byte-for-byte copy of the original plugin.

## Recovered with high confidence

- `src/graph.ts` was recovered as a full source file.
- The plugin concept and file names were recovered from recent screenshot/OCR context:
  - `extension.ts`
  - `parser.ts`
  - `participant.ts`
  - `graph.ts`
  - `package.json`
  - test JavaScript files

## Reconstructed

The following files were reconstructed rather than exactly recovered:

- `package.json`
- `tsconfig.json`
- `.vscodeignore`
- `.gitignore`
- `README.md`
- `RECOVERY_NOTES.md`
- `src/parser.ts`
- `src/extension.ts`
- `src/participant.ts`
- `test/parser.test.js`
- `test/fixtures/sample-debug.jsonl`

## Known uncertainty

- The exact Copilot debug log schema from the original machine may differ. The parser is intentionally tolerant, but may need local schema tuning.
- The exact command IDs and chat participant ID from the original extension may have been different.
- The original `package.json` screenshots were not available as full text; an unrelated `agent-setup-bmad` `package.json` appeared in file search and was intentionally not used.
- No icon, marketplace metadata, or original license file was recovered.

## Suggested validation

```bash
npm install
npm run compile
npm test
```

Then launch the extension development host in VS Code and run:

1. `Copilot Usage: Load Session From File`
2. select a known Copilot/VS Code debug JSONL/log file
3. run `Copilot Usage: Show Current Summary`
4. try `@usage show tools` in chat

If the parser produces an empty graph for your real logs, inspect one log entry and add the field names to the helper lists in `src/parser.ts`.
