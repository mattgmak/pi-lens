// Pure classifier for the clean-signal probe (scripts/probe-clean-signal.mjs).
//
// Splits a PUSH-mode LSP server's clean-scan behavior along TWO axes that must
// not be collapsed (#460 review):
//   - LATENCY axis (does the wait early-return?): pi-lens's publishDiagnostics
//     handler (clients/lsp/client.ts) bumps its INTERNAL diagnosticsVersion and
//     emits on EVERY publish — versioned or not — and waitForDiagnostics
//     early-returns on that emit. So ANY publish on a clean transition resolves
//     the wait; only true SILENCE is budget-bound (the #458 learned-deadline
//     target set).
//   - CURRENCY-PROOF axis (can the publish be tied to the live edit?): the
//     LSP-reported doc version (diagnosticDocVersions) is used only to REJECT
//     provably-lagging results; a version-less publish cannot be proven stale,
//     so it is ACCEPTED as fresh. Version-less publishes therefore early-return
//     fine but carry a weaker staleness guarantee (temporal correlation, not
//     proof) — a staleness-RISK note, not a latency cost.
//
// Hence the 4-way, PHASE-AWARE classification (the dirty touch proves liveness;
// the clean-transition touches are the discriminator):
//   - publishes-versioned   (tier 2 ): publishes WITH version on clean
//     transitions — affirmative + currency-proven (ast-grep).
//   - publishes-unversioned (tier 2*): publishes version-lessly on clean
//     transitions — early-returns the wait at runtime, currency only temporally
//     correlated (opengrep).
//   - silent                (tier 3 ): demonstrably alive (published on dirty)
//     but demonstrably silent on clean transitions — the budget-wait case and
//     the #458 target.
//   - unknown               (tier — ): no publish at all (slow/absent —
//     conservatively not classified).
//
// Kept as a side-effect-free function so it can be unit-tested without spawning
// a server (see tests/scripts/clean-signal.test.ts). #240/#460.

/**
 * @typedef {Object} CleanSignalObservations
 * @property {number} [dirtyPublishes]           publishes during the dirty touch
 *   (cold spawn + first analysis) — proves the server is live
 * @property {number} [dirtyVersioned]           of those, how many carried a version
 * @property {number} [cleanTransitionPublishes] publishes during the clean
 *   transitions (dirty→clean and/or clean→clean touches) — the discriminator
 * @property {number} [cleanTransitionVersioned] of those, how many carried a version
 */

/**
 * Classify a push-mode server's clean-signal behavior from phase-aware publish
 * observations.
 *
 * Conservative by design: `unknown` beats a guess. A server that never published
 * at all is `unknown`, NOT silently downgraded to Tier 3 — a slow/absent server
 * must not be mislabeled as a measured-silent one.
 *
 * @param {CleanSignalObservations} obs
 * @returns {{ behavior: "publishes-versioned" | "publishes-unversioned" | "silent" | "unknown", tier: 2 | 3 | 0, tierLabel: "2" | "2*" | "3" | "", reason: string }}
 */
export function classifyCleanBehavior(obs) {
  const dirtyPublishes = Number(obs?.dirtyPublishes ?? 0);
  const cleanPublishes = Number(obs?.cleanTransitionPublishes ?? 0);
  const cleanVersioned = Number(obs?.cleanTransitionVersioned ?? 0);

  // Published on a clean transition WITH a version → affirmative clean signal,
  // currency-proven (correlatable to the live document version).
  if (cleanPublishes > 0 && cleanVersioned > 0) {
    return {
      behavior: "publishes-versioned",
      tier: 2,
      tierLabel: "2",
      reason: `published ${cleanVersioned}/${cleanPublishes} versioned set(s) on clean transitions — affirmative + currency-proven`,
    };
  }

  // Published on a clean transition but version-lessly → the wait still
  // early-returns at runtime (the client accepts a version-less publish as
  // fresh because it cannot be proven stale), but currency is only temporally
  // correlated — a staleness-risk caveat, NOT a latency cost.
  if (cleanPublishes > 0) {
    return {
      behavior: "publishes-unversioned",
      tier: 2,
      tierLabel: "2*",
      reason: `published ${cleanPublishes} version-less set(s) on clean transitions — early-returns the wait; currency only temporally correlated`,
    };
  }

  // Demonstrably alive (published on the dirty touch) but demonstrably silent
  // on clean transitions → the budget-wait case (#458's learned-deadline target).
  if (dirtyPublishes > 0) {
    return {
      behavior: "silent",
      tier: 3,
      tierLabel: "3",
      reason: `alive (${dirtyPublishes} dirty publish(es)) but silent on clean transitions — budget-wait bound`,
    };
  }

  // Never saw the server publish anything → can't tell silent from slow/absent.
  return {
    behavior: "unknown",
    tier: 0,
    tierLabel: "",
    reason: "no publish observed (server slow/absent — not classifiable)",
  };
}
