/**
 * Shared availability policy for tool probes (#1467).
 *
 * A `--version` probe answers one question — "can I run this tool right now?" —
 * and it can fail for two very different reasons:
 *
 *   * the tool is **missing**: a durable fact about the machine, worth caching
 *     for the session and worth an "install it" message;
 *   * the probe was **transient**: a timeout, an abort, an EAGAIN. That is
 *     evidence about *this moment*, not about the tool. Caching it as a
 *     permanent `false` disables a healthy tool for the life of the process,
 *     and wording it as "not installed" sends the user to reinstall something
 *     that is already on disk.
 *
 * knip hit exactly that: a 5 s host-side probe budget, an event-loop stall that
 * ate most of it, a latched `false`, and three days of "Knip not available.
 * Install with: npm install -D knip" over a knip that answered `--version` in
 * 0.8 s outside the host. This module owns the policy so every client — the
 * `createAvailabilityChecker` seam, knip, madge, govulncheck, vulture — shares
 * one taxonomy, one retry rule, and one message split.
 *
 * Kept dependency-light on purpose (only the latency logger) so client modules
 * can import the policy without pulling in the dispatch/installer graph.
 */

import { logLatency } from "../../../latency-logger.js";

export type AvailabilityOutcome =
	| "success"
	| "missing"
	| "transient"
	| "non-installable";

/**
 * Why a probe reached its verdict. `outcome` decides the control flow (install
 * / retry / give up); `cause` is what we tell the user and log, and it is the
 * only thing that distinguishes "timed out" from "not installed".
 */
export type AvailabilityCause =
	| "ok"
	| "fast-path"
	| "not-found"
	| "probe-timeout"
	| "host-stall"
	| "probe-rejected"
	| "bad-cwd"
	| "policy-denied";

export interface AvailabilityDecision {
	tool: string;
	verdict: "available" | "unavailable";
	outcome: AvailabilityOutcome;
	cause: AvailabilityCause;
	/** Wall time the probe took, ms. 0 for fast paths and cached decisions. */
	elapsedMs: number;
	/** True when this verdict is remembered until the next session reset. */
	latched: boolean;
	/** Host event-loop stall observed while the probe was in flight, ms. */
	hostStallMs?: number;
	/** For a non-latched verdict: how long until the next probe is allowed. */
	retryAfterMs?: number;
	/** Probe budget the verdict was measured against, ms. */
	budgetMs?: number;
}

/**
 * Cooldown after a transient failure. Bounded exponential so a genuinely sick
 * machine is not re-probed every call, while a one-off stall costs at most one
 * cooldown: 30 s, 60 s, 120 s … capped at 5 min.
 */
export const TRANSIENT_BASE_COOLDOWN_MS = 30_000;
export const TRANSIENT_MAX_COOLDOWN_MS = 300_000;

/**
 * A timeout the host itself caused is not evidence about the tool at all, so it
 * gets a short fixed cooldown (just enough to avoid a probe storm while the
 * loop is still stalling) and never escalates.
 */
export const HOST_STALL_COOLDOWN_MS = 5_000;

/**
 * Host stall, in ms, that has to overlap a probe window before we stop counting
 * a timeout as evidence about the tool. Well under the smallest probe budget
 * (1.5 s) so a stall can only ever *soften* a verdict we would otherwise latch.
 */
export const HOST_STALL_EVIDENCE_MS = 500;

/** Never mistake a transient verdict for a durable one. */
export function isLatchingOutcome(outcome: AvailabilityOutcome): boolean {
	return outcome !== "transient";
}

export function transientRetryDelayMs(
	attempts: number,
	cause: AvailabilityCause,
): number {
	if (cause === "host-stall") return HOST_STALL_COOLDOWN_MS;
	const exponent = Math.max(0, attempts - 1);
	return Math.min(
		TRANSIENT_MAX_COOLDOWN_MS,
		TRANSIENT_BASE_COOLDOWN_MS * 2 ** Math.min(exponent, 10),
	);
}

/** The subset of a spawn result the classification actually reads. */
export interface ProbeFailureShape {
	/** The spawn's Error, whose `code` carries the errno when there is one. */
	error?: Error | null;
	status?: number | null;
	failure?: string;
	spawnFailure?: { kind?: string };
}

export interface ClassifyOptions {
	/** Host stall observed during the probe window, ms. */
	hostStallMs?: number;
	/** Compatibility for legacy probes whose test doubles carry no failure kind. */
	unclassifiedFailureOutcome?: AvailabilityOutcome;
}

/**
 * Classify a failed probe into an outcome + cause.
 *
 * The stall arm is the #1467 fix for the measurement itself: the probe budget
 * is enforced by a HOST-side `setTimeout`, so a stalled event loop expires the
 * budget while the child is still healthy and mid-startup. When a stall
 * overlapped the window we keep the outcome transient but re-cause it as
 * `host-stall`, which shortens the cooldown and — critically — says so in the
 * telemetry, instead of silently blaming the tool.
 */
export function classifyProbeFailure(
	result: ProbeFailureShape,
	options: ClassifyOptions = {},
): { outcome: AvailabilityOutcome; cause: AvailabilityCause } {
	const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
	if (result.spawnFailure?.kind === "tool-not-found") {
		return { outcome: "missing", cause: "not-found" };
	}
	if (
		result.failure === "timeout" ||
		result.failure === "aborted" ||
		result.failure === "signal" ||
		result.spawnFailure?.kind === "killed" ||
		result.spawnFailure?.kind === "timeout" ||
		errorCode === "EAGAIN" ||
		errorCode === "EBUSY"
	) {
		const stalled = (options.hostStallMs ?? 0) >= HOST_STALL_EVIDENCE_MS;
		return {
			outcome: "transient",
			cause: stalled ? "host-stall" : "probe-timeout",
		};
	}
	// A present command that rejects its version probe (or an EACCES/EINVAL/
	// UNKNOWN failure) is not repaired by reinstalling it.
	const outcome = options.unclassifiedFailureOutcome ?? "non-installable";
	return {
		outcome,
		cause: outcome === "missing" ? "not-found" : "probe-rejected",
	};
}

/**
 * Accumulate how long the host event loop was blocked while something else was
 * in flight. A timer scheduled every `intervalMs` that fires late by L ms means
 * the loop was unavailable for L ms of the window — exactly the time the probe
 * budget was being spent on the host rather than on the child.
 *
 * `unref`'d and cleared on the single settle path, so it can never hold a
 * print-mode process open (recurring defect shape 4).
 */
export function startHostStallSampler(intervalMs = 100): { stop: () => number } {
	let stallMs = 0;
	let last = Date.now();
	let stopped = false;
	const timer: NodeJS.Timeout | undefined = setInterval(() => {
		const now = Date.now();
		const lateness = now - last - intervalMs;
		if (lateness > 0) stallMs += lateness;
		last = now;
	}, intervalMs);
	timer?.unref?.();
	return {
		stop: (): number => {
			if (stopped) return Math.round(stallMs);
			stopped = true;
			clearInterval(timer);
			// A stall in progress when the probe settles is still stall inside the
			// window; count the tail the interval never got to observe.
			const tail = Date.now() - last - intervalMs;
			if (tail > 0) stallMs += tail;
			return Math.round(stallMs);
		},
	};
}

/**
 * A transient-aware availability latch for clients that memoize their own
 * `available` flag (knip, madge, govulncheck, vulture).
 *
 * `read()` returns `null` when the caller must probe again — either it has
 * never probed, or the last failure was transient and its cooldown has expired.
 * Only a durable outcome (`missing` / `non-installable`) is remembered for the
 * whole session, which is the invariant that stops one slow second at warm-up
 * from disabling an installed tool for the life of the process.
 */
export interface AvailabilityLatch {
	read(): boolean | null;
	noteAvailable(cause?: AvailabilityCause): void;
	/** Returns the retry delay in ms; 0 means the verdict is latched. */
	noteUnavailable(outcome: AvailabilityOutcome, cause: AvailabilityCause): number;
	reset(): void;
	getOutcome(): AvailabilityOutcome | null;
	getCause(): AvailabilityCause | null;
	/** Epoch ms after which a transient verdict may be re-probed; 0 if latched. */
	getRetryAtMs(): number;
}

export function createAvailabilityLatch(): AvailabilityLatch {
	let available: boolean | null = null;
	let outcome: AvailabilityOutcome | null = null;
	let cause: AvailabilityCause | null = null;
	let retryAtMs = 0;
	let transientAttempts = 0;

	return {
		read(): boolean | null {
			if (available !== false) return available;
			if (outcome !== "transient") return false;
			return Date.now() >= retryAtMs ? null : false;
		},
		noteAvailable(nextCause: AvailabilityCause = "ok"): void {
			available = true;
			outcome = "success";
			cause = nextCause;
			retryAtMs = 0;
			transientAttempts = 0;
		},
		noteUnavailable(
			nextOutcome: AvailabilityOutcome,
			nextCause: AvailabilityCause,
		): number {
			available = false;
			outcome = nextOutcome;
			cause = nextCause;
			if (isLatchingOutcome(nextOutcome)) {
				retryAtMs = 0;
				return 0;
			}
			transientAttempts += 1;
			const delay = transientRetryDelayMs(transientAttempts, nextCause);
			retryAtMs = Date.now() + delay;
			return delay;
		},
		reset(): void {
			available = null;
			outcome = null;
			cause = null;
			retryAtMs = 0;
			transientAttempts = 0;
		},
		getOutcome: () => outcome,
		getCause: () => cause,
		getRetryAtMs: () => retryAtMs,
	};
}

/** True when the verdict came from a probe that never got a fair hearing. */
export function isTransientDecision(
	decision: { outcome?: AvailabilityOutcome | null } | null | undefined,
): boolean {
	return decision?.outcome === "transient";
}

/**
 * THE message split. Every "tool X is unavailable" string a user or agent sees
 * is produced here, so "the probe timed out" can never be worded as "install
 * it" again. `installHint` is the command that would actually fix a genuinely
 * missing tool.
 */
export function describeUnavailability(options: {
	tool: string;
	installHint: string;
	outcome?: AvailabilityOutcome | null;
	cause?: AvailabilityCause | null;
	elapsedMs?: number;
	retryAfterMs?: number;
}): string {
	const { tool, installHint } = options;
	if (options.outcome !== "transient") {
		return `${tool} not available. Install with: ${installHint}`;
	}
	const elapsed = options.elapsedMs ? ` after ${options.elapsedMs}ms` : "";
	const stalled =
		options.cause === "host-stall"
			? " (the pi host event loop stalled during the probe window, so the budget expired on the host side)"
			: "";
	const retry = options.retryAfterMs
		? ` Retrying in ${Math.round(options.retryAfterMs / 1000)}s.`
		: " It will be retried.";
	return `${tool} availability probe timed out${elapsed}${stalled}. ${tool} is not reported missing — this is a probe timeout, not a missing install.${retry}`;
}

/**
 * One record per availability DECISION (not per cache hit), so a probe that is
 * failing is visible in latency.log the same day instead of being inferred from
 * three days of silence.
 *
 * Bounded by construction: the seam probes each tool at most once per cwd per
 * session generation, plus once per expired transient cooldown.
 */
export function logAvailabilityDecision(
	decision: AvailabilityDecision,
	filePath = "<pi-lens>",
): void {
	logLatency({
		type: "phase",
		phase: "availability_decision",
		filePath,
		durationMs: Math.round(decision.elapsedMs),
		metadata: {
			tool: decision.tool,
			verdict: decision.verdict,
			outcome: decision.outcome,
			cause: decision.cause,
			latched: decision.latched,
			...(decision.hostStallMs !== undefined && {
				hostStallMs: decision.hostStallMs,
			}),
			...(decision.retryAfterMs !== undefined && {
				retryAfterMs: decision.retryAfterMs,
			}),
			...(decision.budgetMs !== undefined && { budgetMs: decision.budgetMs }),
		},
	});
}
