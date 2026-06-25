# Environment Variables

See [`environment-variables.md`](environment-variables.md) for the full reference.

Common variables:

- `PILENS_DATA_DIR` — redirect per-project persistent state outside the workspace.
- `PI_LENS_STARTUP_MODE` — choose `full`, `minimal`, or `quick` startup mode.
- `PI_LENS_NO_CONTEXT_INJECTION=1` — keep tools, LSP, read-guard, and formatting
  active while disabling automatic turn-end/session-start context injection.
