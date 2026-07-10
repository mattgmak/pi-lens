/**
 * Tier-aware cascade-lane wait policy (#458, re-scope №2).
 *
 * The cascade/deferred lane (`computeCascadeForFile`'s neighbor-touch fan-out
 * in `clients/dispatch/integration.ts`) actively opens neighbor files against
 * their LSP client and waits up to a per-touch budget (~1000ms cold-snapshot /
 * 2000ms warm) for `textDocument/publishDiagnostics` before deciding the
 * neighbor is clean. For a Tier-3 server — one that is `push-only` AND known
 * to publish NOTHING on a clean→clean transition (see
 * docs/lsp-capability-matrix.md; today that's typescript-language-server, the
 * lone core-set instance) — that wait can never distinguish "clean" from
 * "still analyzing"; it always burns its full budget. Dogfooding measured
 * ~221 such `lsp_diagnostics_timeout` events/day.
 *
 * pi 0.80.6's `agent_settled` quiet window (#483, `clients/quiet-window.ts`)
 * gives the cascade lane a place to resolve that ambiguity OUT of the
 * per-touch budget: fire the touch (didOpen/didChange still happens, so the
 * server starts real work), record it as outstanding, and reconcile against
 * whatever landed in the client's diagnostics cache by the time the agent run
 * goes idle. A touch nothing arrived for by then is recorded `unresolved` —
 * never silently treated as `clean` (the #240 doctrine: a missing answer is
 * not an affirmative answer).
 *
 * This module is deliberately NOT hardcoded to server names for the "should
 * this file skip its in-lane wait" question: it reads the live capability
 * snapshot's `workspaceDiagnosticsSupport.mode` (from
 * `detectWorkspaceDiagnosticsSupport`, cached at `initialize`) and combines it
 * with the `silentOnClean` marker on that server's `DiagnosticStrategy`
 * (`server-strategies.ts`) — the same per-server behavioral-knowledge table
 * the rest of the LSP layer already uses. A server with no live snapshot yet,
 * or whose mode isn't `push-only`, or that isn't marked `silentOnClean`, is
 * NOT tier-3 — the caller keeps today's full in-lane wait. Fail-safe is
 * always "wait like before".
 */

import { logCascade } from "../cascade-logger.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey } from "../path-utils.js";
import { registerQuietWindowTask } from "../quiet-window.js";
import { getServersForFileWithConfig } from "./config.js";
import type { LSPService } from "./index.js";
import { getStrategy } from "./server-strategies.js";

// --- Kill switch (lazy, memoized — house style per clients/runtime-config.ts /
// clients/quiet-window.ts's isQuietWindowEnabled) ---

let _enabledCache: boolean | undefined;

/** `PI_LENS_TIER_AWARE_CASCADE=0` disables the whole feature: every cascade
 * touch waits in-lane exactly as it did before #458, no outstanding-touch
 * bookkeeping, no reconcile task registered. */
export function isTierAwareCascadeEnabled(): boolean {
	if (_enabledCache !== undefined) return _enabledCache;
	_enabledCache = process.env.PI_LENS_TIER_AWARE_CASCADE !== "0";
	return _enabledCache;
}

/** Test-only: clear the memoized kill-switch read. */
export function _resetTierAwareCascadeEnabledForTests(): void {
	_enabledCache = undefined;
}

export type CascadeWaitTier = "tier3-silent" | "waits";

/**
 * Classify whether `filePath`'s PRIMARY language server is a cascade-lane
 * Tier-3 (push-only, silent-on-clean) server. Ambiguous or missing capability
 * data is always `"waits"` (today's behavior) — this function must never be
 * the reason a real answer gets missed.
 */
export function classifyCascadeWaitTier(
	lspService: Pick<LSPService, "getCapabilitySnapshots">,
	filePath: string,
	snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): CascadeWaitTier {
	void lspService; // kept in the signature for call-site clarity/typing only
	const servers = getServersForFileWithConfig(filePath).filter(
		(s) => s.role !== "auxiliary",
	);
	const primary = servers[0];
	if (!primary) return "waits";

	const snapshot = snapshots.find((s) => s.serverId === primary.id);
	if (!snapshot) return "waits"; // no live snapshot yet — fail-safe

	const mode = snapshot.workspaceDiagnosticsSupport?.mode;
	if (mode !== "push-only") return "waits"; // pull servers are always affirmative

	const strategy = getStrategy(primary.id);
	if (strategy.silentOnClean !== true) return "waits"; // 2*/unknown push-only

	return "tier3-silent";
}

// --- Outstanding-touch registry -------------------------------------------

interface OutstandingTouch {
	filePath: string;
	serverId: string;
	/** The client's diagnosticsVersion counter at touch time (baseline). */
	baselineVersion: number;
	touchedAt: number;
}

// Keyed by normalized file path. A later touch for the same file simply
// replaces the earlier entry (only the most recent baseline matters — an
// older touch's diagnostics, if they ever arrive, are still a strict superset
// concern the newer touch already re-supersedes via didOpen/didChange).
const _outstandingTouches = new Map<string, OutstandingTouch>();

/**
 * Record a Tier-3 cascade touch that skipped its in-lane wait. Called right
 * after the (still-performed) didOpen/didChange notify, before returning
 * without waiting. `baselineVersion` is the client's `diagnosticsVersion`
 * counter sampled immediately before the notify, so the reconcile task can
 * tell whether anything published since.
 */
export function recordOutstandingCascadeTouch(entry: OutstandingTouch): void {
	_outstandingTouches.set(normalizeMapKey(entry.filePath), entry);
}

/** Test-only: clear the outstanding-touch registry between test cases. */
export function _resetOutstandingCascadeTouchesForTests(): void {
	_outstandingTouches.clear();
}

/** Test-only: peek at the registry without mutating it. */
export function _getOutstandingCascadeTouchesForTests(): OutstandingTouch[] {
	return [...(_outstandingTouches.values() as Iterable<OutstandingTouch>)];
}

export interface ReconcileOutcome {
	filePath: string;
	serverId: string;
	outcome: "resolved-found" | "resolved-clean" | "unresolved";
	ageMs: number;
	diagnosticCount?: number;
}

/**
 * Reconcile every outstanding Tier-3 touch against the LSP client's current
 * diagnostics cache. For each:
 *   - If the client's `diagnosticsVersion` advanced past the touch's baseline,
 *     something published since — pull `getDiagnostics(filePath)` and record
 *     `resolved-found` (diagnostics present) or `resolved-clean` (empty, but
 *     PROVEN empty by an actual publish after the touch).
 *   - If nothing published by settle time, record `unresolved` — per the
 *     #240 doctrine this is NEVER treated as clean.
 *
 * Always drains the whole registry (each entry is independently resolved;
 * one entry's client lookup failing doesn't block the rest) and never
 * throws — callers (the quiet-window task) must be fail-safe.
 */
export async function reconcileOutstandingCascadeTouches(
	lspService: Pick<LSPService, "getClientForFile">,
): Promise<ReconcileOutcome[]> {
	const outcomes: ReconcileOutcome[] = [];
	const entries = [..._outstandingTouches.entries()];
	_outstandingTouches.clear();

	for (const [key, touch] of entries) {
		const ageMs = Date.now() - touch.touchedAt;
		try {
			const spawned = await lspService.getClientForFile(touch.filePath);
			if (!spawned || spawned.client.serverId !== touch.serverId) {
				outcomes.push({
					filePath: touch.filePath,
					serverId: touch.serverId,
					outcome: "unresolved",
					ageMs,
				});
				continue;
			}
			const advanced = spawned.client.diagnosticsVersion > touch.baselineVersion;
			if (!advanced) {
				outcomes.push({
					filePath: touch.filePath,
					serverId: touch.serverId,
					outcome: "unresolved",
					ageMs,
				});
				continue;
			}
			const diags = spawned.client.getDiagnostics(touch.filePath);
			outcomes.push({
				filePath: touch.filePath,
				serverId: touch.serverId,
				outcome: diags.length > 0 ? "resolved-found" : "resolved-clean",
				ageMs,
				diagnosticCount: diags.length,
			});
		} catch (err) {
			outcomes.push({
				filePath: touch.filePath,
				serverId: touch.serverId,
				outcome: "unresolved",
				ageMs,
			});
			logLatency({
				type: "phase",
				phase: "cascade_tier3_reconcile_error",
				filePath: key,
				durationMs: 0,
				metadata: { error: String(err) },
			});
		}
	}
	return outcomes;
}

let _reconcileTaskRegistered = false;

/**
 * Register the Tier-3 reconcile task with the quiet-window scheduler
 * (`clients/quiet-window.ts`). Idempotent — safe to call more than once
 * (e.g. multiple extension activations in tests).
 */
export function registerCascadeTierReconcileTask(
	getLspService: () => Pick<LSPService, "getClientForFile">,
): void {
	if (_reconcileTaskRegistered) return;
	_reconcileTaskRegistered = true;

	registerQuietWindowTask("cascade_tier3_reconcile", async () => {
		if (!isTierAwareCascadeEnabled()) return;
		if (_outstandingTouches.size === 0) return;
		const outcomes = await reconcileOutstandingCascadeTouches(getLspService());
		if (outcomes.length === 0) return;

		let resolvedFound = 0;
		let resolvedClean = 0;
		let unresolved = 0;
		let ageSumMs = 0;
		for (const o of outcomes) {
			if (o.outcome === "resolved-found") resolvedFound++;
			else if (o.outcome === "resolved-clean") resolvedClean++;
			else unresolved++;
			ageSumMs += o.ageMs;
		}
		const avgAgeMs = Math.round(ageSumMs / outcomes.length);

		logCascade({
			phase: "cascade_tier3_reconcile",
			filePath: "<quiet-window>",
			metadata: {
				count: outcomes.length,
				resolvedFound,
				resolvedClean,
				unresolved,
				avgAgeMs,
				outcomes,
			},
		});
	});
}

/** Test-only: undo registerCascadeTierReconcileTask's idempotency guard. */
export function _resetCascadeTierReconcileRegistrationForTests(): void {
	_reconcileTaskRegistered = false;
}
