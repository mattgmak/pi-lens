# LSP capability matrix — affirmative-clean-signal strategy

How pi-lens knows a just-edited file is **clean** (no diagnostics) vs the server
simply **hasn't answered yet** (cold/crashed/silent). pi-lens waits *synchronously*
for a verdict, so — unlike an editor, which renders asynchronously and never needs
to decide — it must have a positive signal. There is no signal for "silence", so we
classify each server and pick a per-server strategy. (Background: #240; mechanism
confirmed against Neovim's LSP client, which sidesteps this entirely by being async.)

Generate/refresh this matrix with `node scripts/characterize-lsp.mjs [--install]`
(mode) and `scripts/probe-clean-signal.mjs` + `PILENS_PUB_DEBUG=1` (clean-behavior).

## The three strategies

| Tier | Signal | Affirmative clean? | Example |
|---|---|---|---|
| **1 — pull** | `textDocument/diagnostic` returns an authoritative report (empty = clean) | YES, deterministic | rust-analyzer |
| **2 — push, re-publishes empty** | `publishDiagnostics([])` **with version** on every scan, incl. clean→clean | YES, via version bump | ast-grep |
| **3 — push, silent on clean** | server publishes nothing when nothing changed | **NO** — budget-wait floor (safe; a timeout is *not* a false clean) | typescript-language-server |

Detection is **cached** at `initialize` (`detectWorkspaceDiagnosticsSupport` →
`state.workspaceDiagnosticsSupport.mode`, upgraded on `client/registerCapability`),
so the tier is free at collection time — no per-edit probe.

## Matrix (dev box + CI nightly, last refreshed 2026-06-17 from run 27713958681)

`mode` from cached capabilities; `clean-behavior` from the publish-trace probe
(only servers actually probed are marked — TBD otherwise). `src` = where the mode
was measured: **ci** = the nightly `characterize-lsp.mjs` step, **dev** = the dev
box. A few `dev` rows returned `unknown` in CI this run (the server spawned but
didn't surface a mode within the characterize budget) — the `dev` value stands.

| lang | server | mode | clean-behavior | tier | src |
|---|---|---|---|---|---|
| json | vscode-json-language-server | pull | — | 1 | dev |
| css | vscode-css-language-server | pull | — | 1 | dev |
| html | vscode-html-language-server | pull | — | 1 | dev |
| rust | rust-analyzer | pull | — | 1 | dev |
| svelte | svelte-language-server | pull | — | 1 | dev+ci |
| deno | deno (alt of typescript) | pull | — | 1 | dev+ci |
| ruby | ruby-lsp | pull | — | 1 | ci |
| csharp | csharp-ls | pull | — | 1 | ci |
| typescript | typescript-language-server | push-only | **silent** (probed) | 3 | dev |
| python | pyright | push-only | TBD | 2/3? | dev |
| jedi | jedi-language-server (alt of python) | push-only | TBD | 2/3? | ci |
| yaml | yaml-language-server | push-only | TBD | 2/3? | dev |
| shell | bash-language-server | push-only | TBD | 2/3? | dev |
| dockerfile | docker-langserver | push-only | TBD | 2/3? | dev |
| toml | taplo | push-only | TBD | 2/3? | dev |
| terraform | terraform-ls | push-only | TBD | 2/3? | dev |
| prisma | @prisma/language-server | push-only | TBD | 2/3? | dev+ci |
| php | intelephense | push-only | TBD | 2/3? | dev |
| zig | zls | push-only | TBD | 2/3? | dev+ci |
| vue | @vue/language-server | push-only | TBD | 2/3? | dev+ci |
| dart | dart language-server | push-only | TBD | 2/3? | ci |
| gleam | gleam lsp | push-only | TBD | 2/3? | ci |
| clojure | clojure-lsp | push-only | TBD | 2/3? | ci |
| opengrep | opengrep (aux) | push-only | re-publishes (early-returns ~1.2s) | 2 | dev+ci |
| ast-grep | ast-grep (aux) | push-only | **re-publishes empty+version** (probed) | 2 | dev+ci |

**Unknown — fixture exists, mode not yet captured.** The toolchain-gated family
(no auto-install today; tracked in #241) — `go` (gopls), `java` (jdtls),
`kotlin`, `swift` (sourcekit-lsp), `lua`, `cpp` (clangd), `haskell`, `elixir`,
`ocaml`, `nix` (nixd), `fsharp`. Their servers don't install in the nightly, so
characterize reports `unknown` (a non-failure ⚠). Once #241 lands they'll fill in
the same way clojure-lsp/gleam now do (both auto-install via the github strategy
and were characterized `push-only` in the run above).

## Key findings
- **Mode ≠ tier.** Push-only further splits into Tier 2 (re-publishes empty — ast-grep,
  opengrep) vs Tier 3 (silent — typescript). That split needs the clean→clean behavior
  probe per server; only ast-grep, opengrep, and typescript are probed so far.
- **Tier 3 is budget-bound by necessity**, not laziness: a silent server's silence is
  ambiguous (clean-unchanged vs still-analyzing), so shortening the wait or reusing
  `lastKnownDiagnostics` would risk a false clean. The wait *is* the safety mechanism.
- **ast-grep (Phase 2 / #239) is Tier 2** — it self-signals clean on every scan, so it
  is not the bottleneck. The cost on a clean with-auxiliary touch is the *silent
  primary* (typescript), a pre-existing Tier-3 cost independent of ast-grep.

## Completing the matrix
The fixtures (`tests/fixtures/tool-smoke/<lang>/`) are durable and cover every
registered server. `mode` is read from the server's advertised capabilities at
`initialize`, so it is **content-independent** — for languages that already had a
tool-layer fixture we point `characterize-lsp.mjs` at the existing (deliberately
dirty) `bad.*` source rather than a colliding clean duplicate; new languages get a
minimal clean source. Either way the mode reported is the same.

The nightly **tool-smoke** workflow runs `characterize-lsp.mjs --install` (after the
LSP handshake layer) on `ubuntu-latest`, so the matrix's `mode` column self-populates
in CI. It fills for servers that either auto-install (npm/pip/github — including
clojure-lsp and gleam, both github-strategy as of f263cf3) or whose toolchain the
workflow provisions (Ruby/Dart/Zig + .NET→csharp). The remaining `unknown` rows are
the toolchain-gated family (#241): until `runtimeInstall` + canonical-bin discovery
land, their servers don't install in CI and stay ⚠.

Each row still needs (2) the clean→clean publish-behavior probe (`probe-clean-signal.mjs`
+ `PILENS_PUB_DEBUG=1`) to split push-only into Tier 2 (re-publishes empty) vs Tier 3
(silent). Only typescript (Tier 3) and ast-grep/opengrep (Tier 2) are probed so far —
that second cut is still per-server and manual.
