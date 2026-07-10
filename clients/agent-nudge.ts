/**
 * Inline agent nudge for out-of-view file mutations (#485).
 *
 * Autofixes applied DURING a tool call surface in that tool's result — the
 * agent sees those today. Everything that lands AFTER the tool result
 * (deferred-cascade autofixes settling at turn_end, quiet-window work (#483),
 * and — later — writes by other extensions once pi-lens consumes bus events)
 * is invisible to the model. This module closes that gap: it subscribes to
 * the `pilens:files:touched` bus event pi-lens itself publishes (#482,
 * clients/bus-publish.ts), accumulates touched paths per turn-gap, filters
 * them down to files the session actually read or edited (the read-guard
 * already tracks this — an untouched file's autoformat is not the agent's
 * business), and injects ONE terse message at the next turn via the same
 * `context`-event channel index.ts already uses for turn-end findings
 * (clients/runtime-context.ts). `context` (`transformContext` in the SDK,
 * dist/core/sdk.js) fires before EVERY provider/LLM call, including the
 * first call of a brand-new `agent_start` run in the same session — not just
 * mid-run turn boundaries. That matters: the primary real-world case this
 * solves is an agent that runs `git status` at the start of a fresh run and
 * finds files it did not knowingly modify, because pi-lens autoformatted
 * them at a PREVIOUS run's turn_end. The accumulator therefore survives
 * across agent_end/agent_settled — it is only ever cleared inside
 * `consumeAgentNudge`, i.e. at actual injection time.
 *
 * Three channels, three audiences (doctrine, see AGENTS.md):
 *   - bus events    -> EXTENSIONS (#482)
 *   - display-only  -> the HUMAN (#484)
 *   - context nudge -> the MODEL (this module, #485)
 * One feed (`pilens:files:touched`), three deliveries.
 *
 * Loop-guard alignment with #482: this subscriber is READ-ONLY on the bus —
 * it never calls `publishFilesTouched` (or anything else that emits on the
 * bus). ingest -> nudge can therefore never become ingest -> write -> publish;
 * there is no write side to this module at all, so the origin flag #482
 * defined for its own future consumers has nothing to trip here.
 *
 * Feature detection: `pi.events.on(channel, handler)` per
 * node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.d.ts;
 * `pi.events` itself is typed at
 * dist/core/extensions/types.d.ts:977. Both are guarded with optional
 * chaining / try-catch so an older host that lacks `pi.events` (or a future
 * host that removes `.on`) simply never wires the subscriber — no throw, no
 * behavior change beyond "no nudges".
 */
import type { FilesTouchedPayload } from "./bus-publish.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import type { ReadGuard } from "./read-guard.js";

const BUS_FILES_TOUCHED_EVENT = "pilens:files:touched";
const MAX_NAMES_SHOWN = 5;

interface AccumulatedFile {
	/** Original (non-normalized) path, for display. First-seen form wins. */
	displayPath: string;
	reasons: Set<FilesTouchedPayload["reason"]>;
}

// Module-level accumulator: one process/session, so a plain map keyed via
// normalizeMapKey (house style — every map/set key in this module MUST go
// through it; a hand-rolled replace() is the exact trap that cost two red CI
// rounds this week on the sibling #439-441 batch) is sufficient. Cleared ONLY
// inside consumeAgentNudge() (i.e. only at actual injection into a `context`
// call) — deliberately NOT tied to turn_start/agent_end/agent_settled, so
// entries accumulated during run A's turn_end survive until run B's first
// `context` call in the same session (the cross-run `git status` case).
const _touched = new Map<string, AccumulatedFile>();

/** Test-only: clear accumulator state between test files/cases. */
export function _resetAgentNudgeForTests(): void {
	_touched.clear();
	_enabledCache = undefined;
}

// --- Kill switch (lazy, memoized — house style per clients/quiet-window.ts) ---

let _enabledCache: boolean | undefined;

/** `PI_LENS_AGENT_NUDGE=0` disables accumulation and injection outright. */
export function isAgentNudgeEnabled(): boolean {
	if (_enabledCache === undefined) {
		_enabledCache = process.env.PI_LENS_AGENT_NUDGE !== "0";
	}
	return _enabledCache;
}

function isValidPayload(data: unknown): data is FilesTouchedPayload {
	if (!data || typeof data !== "object") return false;
	const p = data as Partial<FilesTouchedPayload>;
	return (
		p.v === 1 &&
		p.source === "pi-lens" &&
		(p.reason === "autofix" || p.reason === "format") &&
		Array.isArray(p.paths)
	);
}

/**
 * Record a `pilens:files:touched` event into the accumulator, filtered to
 * files the session has actually read or edited (read-guard is the source of
 * truth — `getReadHistory`/`getEditHistory` both key internally via
 * `normalizeFilePath`, so either separator form on the incoming bus payload
 * or the guard's stored records resolves to the same record regardless of
 * which form was recorded first).
 */
function recordTouchedEvent(
	payload: FilesTouchedPayload,
	getReadGuard: () => ReadGuard | undefined,
): void {
	const readGuard = getReadGuard();
	if (!readGuard) return;

	for (const rawPath of payload.paths) {
		const isRelevant =
			readGuard.getReadHistory(rawPath).length > 0 ||
			readGuard.getEditHistory(rawPath).length > 0;
		if (!isRelevant) continue;

		const mapKey = normalizeMapKey(rawPath);
		const existing = _touched.get(mapKey);
		if (existing) {
			existing.reasons.add(payload.reason);
		} else {
			_touched.set(mapKey, {
				displayPath: rawPath,
				reasons: new Set([payload.reason]),
			});
		}
	}
}

export interface WireAgentNudgeSubscriberArgs {
	/** `pi.events` from the extension API, or undefined on older hosts. */
	events: { on?: (channel: string, handler: (data: unknown) => void) => () => void } | undefined;
	/** Resolve the live ReadGuard lazily (session-scoped, created on first use). */
	getReadGuard: () => ReadGuard | undefined;
	dbg?: (msg: string) => void;
}

/**
 * Subscribe to `pilens:files:touched` on pi's shared event bus. Called once
 * at extension factory time from index.ts, mirroring `wireBusEmitter`'s
 * placement (clients/bus-publish.ts). No-ops silently when `pi.events` or
 * `.on` is unavailable (older pi host) — never throws.
 */
export function wireAgentNudgeSubscriber(
	args: WireAgentNudgeSubscriberArgs,
): void {
	const { events, getReadGuard, dbg } = args;
	if (!events?.on) return;

	try {
		events.on(BUS_FILES_TOUCHED_EVENT, (data: unknown) => {
			if (!isAgentNudgeEnabled()) return;
			if (!isValidPayload(data)) return;
			try {
				recordTouchedEvent(data, getReadGuard);
			} catch (err) {
				dbg?.(`agent-nudge: failed to record touched event: ${err}`);
			}
		});
	} catch (err) {
		dbg?.(`agent-nudge: subscribe failed (older pi host?): ${err}`);
	}
}

/**
 * Consume the accumulated touched-file set and produce (at most) one context
 * message, e.g.:
 *   "pi-lens: 2 file(s) were autoformatted after your last turn: a.ts, b.ts —
 *    working-tree changes to these are expected; re-read before editing."
 * The provenance framing ("pi-lens ... expected") matters: the primary pain
 * case is an agent running `git status` (often at the START of a brand-new
 * run/session, not just mid-run) and burning turns investigating diffs it
 * did not knowingly make. Naming pi-lens as the source lets the agent act
 * (re-read, proceed) instead of investigating.
 *
 * Clears the accumulator ONLY here, on actual injection — never on
 * agent_end/agent_settled/turn_start. Files formatted at the last turn_end of
 * a PREVIOUS run must still nudge at the first turn of the NEXT run in the
 * same session: this function is invoked from the `context` extension event
 * (index.ts), which fires before every provider/LLM call — including the
 * very first call of a fresh `agent_start` — so the accumulator surviving
 * across run boundaries is exactly what makes that cross-run delivery work.
 * Empty accumulator ⇒ returns undefined ⇒ zero bytes injected.
 */
export function consumeAgentNudge(
	dbg?: (msg: string) => void,
): { messages: Array<{ role: "user"; content: string }> } | undefined {
	const entries = Array.from(_touched.values());
	_touched.clear();

	if (!isAgentNudgeEnabled()) return undefined;
	if (entries.length === 0) return undefined;

	try {
		const filesTotal = entries.length;
		const shown = entries.slice(0, MAX_NAMES_SHOWN);
		const remaining = filesTotal - shown.length;

		// Determine a single verb covering every reason seen across all
		// accumulated files (not just the shown subset) — most turns will have
		// a single uniform reason, so keep that common case terse; a mix of
		// autofix + format across the batch falls back to a combined verb.
		const allReasons = new Set<FilesTouchedPayload["reason"]>();
		for (const e of entries) {
			for (const r of e.reasons) allReasons.add(r);
		}
		const verbLabel =
			allReasons.size > 1
				? "autofixed/reformatted"
				: allReasons.has("format")
					? "reformatted"
					: "autofixed";

		const names = shown.map((e) => e.displayPath);
		const nameList =
			remaining > 0
				? `${names.join(", ")}, and ${remaining} more`
				: names.join(", ");

		const message = `pi-lens: ${filesTotal} file(s) were ${verbLabel} after your last turn: ${nameList} — working-tree changes to these are expected; re-read before editing.`;

		logLatency({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "agent_nudge",
			durationMs: 0,
			metadata: {
				filesTotal,
				filesShown: shown.length,
				filesFiltered: filesTotal - shown.length,
				reasonMix: Array.from(allReasons),
			},
		});

		return {
			messages: [
				{
					role: "user",
					content: `[pi-lens automated context — not a user request] ${message}`,
				},
			],
		};
	} catch (err) {
		dbg?.(`agent-nudge: consume failed: ${err}`);
		return undefined;
	}
}
