import { beforeEach, describe, expect, it, vi } from "vitest";
import { logExtension } from "../../clients/extension-log.js";
vi.mock("../../clients/extension-log.js", () => ({ logExtension: vi.fn() }));
import {
	DEGRADATION_ENTRIES_PER_KIND,
	DEGRADATION_MAX_DISTINCT_KINDS,
	getDegradationSummary,
	incrementDegradationCount,
	recordDegradation,
	recordDegradationOnce,
	renderDegradationLines,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

beforeEach(() => {
	resetDegradationLedger();
	vi.mocked(logExtension).mockClear();
});

describe("session degradation ledger", () => {
	it("groups kinds and returns detached latest reasons", () => {
		recordDegradation({ kind: "spawn-failure", subject: "a", reason: "denied" });
		recordDegradation({ kind: "trust-refusal", subject: "b", reason: "untrusted" });
		recordDegradation({ kind: "spawn-failure", subject: "c", reason: "bad cwd" });
		const summary = getDegradationSummary();
		expect(summary.map(({ kind, count }) => ({ kind, count }))).toEqual([
			{ kind: "spawn-failure", count: 2 },
			{ kind: "trust-refusal", count: 1 },
		]);
		expect(summary[0].latestReasons.at(-1)).toEqual({ subject: "c", reason: "bad cwd" });
		summary[0].latestReasons[0].reason = "mutated";
		expect(getDegradationSummary()[0].latestReasons[0].reason).toBe("denied");
	});

	it("bounds retained entries per kind while counting beyond the cap", () => {
		for (let i = 0; i < DEGRADATION_ENTRIES_PER_KIND + 7; i++) {
			recordDegradation({ kind: "formatter-skip", subject: `f${i}`, reason: `r${i}` });
		}
		const [group] = getDegradationSummary();
		expect(group.count).toBe(DEGRADATION_ENTRIES_PER_KIND + 7);
		expect(group.droppedCount).toBe(7);
		expect(group.latestReasons).toHaveLength(DEGRADATION_ENTRIES_PER_KIND);
		expect(group.latestReasons[0].subject).toBe("f7");
	});

	it("dedupes once-records and tallies repeated events into one subject entry", () => {
		const formatter = { kind: "formatter-failure" as const, subject: "prettier:a.ts", reason: "timed out" };
		recordDegradationOnce(formatter);
		recordDegradationOnce(formatter);
		for (let i = 0; i < 3; i++) incrementDegradationCount({
			kind: "lsp-diagnostics-timeout",
			subject: "typescript",
			reason: "diagnostics wait timed out",
		});
		const [failure, timeouts] = getDegradationSummary();
		expect(failure.count).toBe(1);
		expect(timeouts.count).toBe(3);
		expect(timeouts.latestReasons).toEqual([{ subject: "typescript", reason: "diagnostics wait timed out (count: 3)" }]);
	});

	it("renders a health section only when degraded", () => {
		expect(renderDegradationLines()).toEqual([]);
		recordDegradation({ kind: "grammar-blocked", subject: "swift.wasm", reason: "runtime unsafe" });
		expect(renderDegradationLines()).toEqual([
			"Degradations:",
			"  ⚠ grammar-blocked: 1 — swift.wasm: runtime unsafe",
		]);
	});

	it("renders newly wired degradation kinds", () => {
		recordDegradation({ kind: "formatter-failure", subject: "prettier:a.ts", reason: "timed out" });
		expect(renderDegradationLines().at(-1)).toContain("formatter-failure: 1");
	});

	// #1366 review: reasons carry arbitrary error text -- bounded at record
	// time so health lines and retained strings stay small.
	it("truncates oversized subjects and reasons at record time", () => {
		resetDegradationLedger();
		recordDegradation({
			kind: "trust-refusal",
			subject: "s".repeat(500),
			reason: "r".repeat(10_000),
		});
		const [group] = getDegradationSummary();
		const latest = group.latestReasons.at(-1)!;
		expect(latest.subject.length).toBeLessThanOrEqual(201);
		expect(latest.reason.length).toBeLessThanOrEqual(201);
		const lines = renderDegradationLines();
		expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(500);
	});

	it("normalizes undefined subjects without breaking either recording path", () => {
		expect(() => recordDegradation({ kind: "spawn-failure", subject: undefined, reason: undefined })).not.toThrow();
		expect(() => incrementDegradationCount({ kind: "lsp-diagnostics-timeout", subject: undefined, reason: undefined })).not.toThrow();
		expect(getDegradationSummary()).toEqual([
			{
				kind: "spawn-failure",
				count: 1,
				droppedCount: 0,
				latestReasons: [{ subject: "unknown", reason: "unknown" }],
			},
			{
				kind: "lsp-diagnostics-timeout",
				count: 1,
				droppedCount: 0,
				latestReasons: [{ subject: "unknown", reason: "unknown (count: 1)" }],
			},
		]);
	});

	it("bounds distinct kinds and truncates oversized kinds", () => {
		for (let i = 0; i < 100; i++) {
			recordDegradation({ kind: `garbage-${i}`, subject: "s", reason: "r" });
		}
		expect(getDegradationSummary()).toHaveLength(DEGRADATION_MAX_DISTINCT_KINDS);
		expect(() => renderDegradationLines()).not.toThrow();

		resetDegradationLedger();
		recordDegradation({ kind: "k".repeat(10_000), subject: "s", reason: "r" });
		expect(getDegradationSummary()[0].kind.length).toBeLessThanOrEqual(201);
	});

	it("swallows failures caused by corrupted telemetry input", () => {
		const corrupted = { toString: () => { throw new Error("corrupted ledger value"); } };
		expect(() => recordDegradation({ kind: "spawn-failure", subject: corrupted, reason: "ignored" })).not.toThrow();
		expect(() => recordDegradationOnce({ kind: "spawn-failure", subject: corrupted, reason: "ignored" })).not.toThrow();
		expect(() => incrementDegradationCount({ kind: "spawn-failure", subject: "ok", reason: corrupted })).not.toThrow();
		expect(vi.mocked(logExtension).mock.calls.filter(([entry]) =>
		entry.level === "debug" && entry.subsystem === "degradation-ledger",
	)).toHaveLength(3);
	});

	it.each([null, undefined, { malformed: true }, [{ kind: "bad" }]])("renders malformed summary %p as empty", (summary) => {
		expect(renderDegradationLines(summary)).toEqual([]);
	});
});
