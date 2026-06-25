# Tools and Commands

This page covers runtime flags and pi-lens slash commands. For supported languages and installable external tools, see [`language-coverage.md`](language-coverage.md) and [`dependencies.md`](dependencies.md).

```bash
# Standard mode (LSP enabled by default)
pi

# Optional switches
pi --no-lens             # Start pi-lens disabled for this session; /lens-toggle can re-enable
pi --no-lens-context     # Disable automatic context injection only (tools/LSP/read-guard/format stay on); /lens-context-toggle
pi --no-lsp              # Disable unified LSP diagnostics
pi --no-autoformat        # Skip auto-formatting entirely
pi --immediate-format      # Format immediately after each edit instead of deferring to agent_end
pi --no-autofix           # Skip auto-fix (Biome, Ruff, ESLint, stylelint, sqlfluff, RuboCop)
pi --no-tests             # Skip test runner
pi --no-delta             # Disable delta mode (show all diagnostics, not just new ones)
pi --lens-guard           # Block git commit/push when unresolved blockers exist (experimental)
pi --no-opengrep          # Disable the Opengrep security scanner (default-on auxiliary LSP)
```

## Key Commands

- `/lens-toggle` — toggle pi-lens on/off for the current session without restarting
- `/lens-context-toggle` — toggle automatic context injection on/off for the session (tools/LSP/read-guard/formatting stay active)
- `/lens-widget-toggle` — show/hide the pi-lens diagnostics widget below the editor
- `/lens-booboo` — full quality report for current project state
- `/lens-health` — runtime health, latency, and diagnostic telemetry
- `/lens-allow-edit <path>` — override the read-before-edit guard for a single edit
- `/lens-tools` — tool installation status: globally installed, auto-installed, or npx fallback
- `/lens-tdi` — Technical Debt Index (TDI) and project health trend
