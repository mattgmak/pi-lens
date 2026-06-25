# Agent-Facing Tools

pi-lens registers the following tools with the pi agent. They are also exposed
through the MCP mirror (`clients/lens-engine.ts` is the seam both adapters
share).

## Per-edit

- **`lens_diagnostics`** — Cached diagnostic state for the current session.
  Modes: `delta` (current turn), `all` (resurfaces stale blockers dropped from
  turn context), `full` (project-wide scan).
- **`lsp_diagnostics`** — File- or directory-scoped LSP diagnostics via the
  active language server.
- **`lsp_navigation`** — IDE-style navigation: `definition`, `references`,
  `implementation`, `typeDefinition`, `declaration`, `rename`, `rename_file`,
  `hover`, `documentSymbol`, `workspaceSymbol`, `signatureHelp`,
  `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `executeCommand`,
  and `capabilities`. Position-based operations accept a `path`/`line`/`character`
  triple.
- **`ast_grep_search`** — AST-aware structural search across ~40 languages via
  the `sg` CLI. Supports metavariables (`$VAR`, `$$$ARGS`), `strictness`
  modes (`smart`, `relaxed`, `ast`, `cst`, `signature`, `template`), and
  pagination via `skip`.
- **`ast_grep_replace`** — AST-aware structural replace. Re-validates the pattern
  against the current file before writing and reports a clear error if the
  file changed since the preview.

## Project intelligence

- **`module_report`** — Navigable outline of a file: every symbol's name/kind/
  startLine/endLine/signature, exported vs internal split, class/interface
  member nesting, who-uses-this, fanout/complexity risk flags, and a
  `recommendedReads` top-3 ranked by usage + complexity. Pass `blastRadius: true`
  for cross-file transitive dependents (read-only over the cached graph).
- **`read_symbol`** — One symbol's verbatim source body. Returned body is
  recorded as genuine read-guard coverage for that symbol's line range.

## Session

- **`lens_health`** — Runtime health, latency telemetry, and current LSP
  status.
- **`lens_project_scan`** — Cheap project-wide scans (knip, jscpd, dep-graph).
- **`lens_booboo`** (slash command, not a tool) — Full quality report for the
  current project state.
