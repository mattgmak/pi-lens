/**
 * #1467 — a transient probe failure must not latch permanent unavailability.
 *
 * These assert the SHARED seam (`createAvailabilityChecker` + the availability
 * policy), which is what knip, madge, jscpd and every other spawn-probed client
 * resolve through. Per-client wiring is covered in
 * `availability-latching-clients.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyProbeFailure,
	createAvailabilityLatch,
	describeUnavailability,
	HOST_STALL_COOLDOWN_MS,
	startHostStallSampler,
	TRANSIENT_BASE_COOLDOWN_MS,
	transientRetryDelayMs,
} from "../../../../clients/dispatch/runners/utils/availability-policy.ts";
import {
	createAvailabilityChecker,
	resetDispatchAvailabilityState,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.ts";

const { logLatencySpy } = vi.hoisted(() => ({ logLatencySpy: vi.fn() }));

vi.mock("../../../../clients/latency-logger.js", () => ({
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

vi.mock("../../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => null),
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({ ...process.env })),
}));

const timeoutResult = () => ({
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("Process timed out after 5000ms"), {}),
	failure: "timeout" as const,
	spawnFailure: { kind: "timeout" } as never,
});

const missingResult = () => ({
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }),
	failure: "spawn" as const,
	spawnFailure: { kind: "tool-not-found" } as never,
});

const okResult = () => ({ stdout: "1.0.0", stderr: "", status: 0 });

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

describe("availability seam: transient failures do not latch (#1467)", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockReset();
		logLatencySpy.mockReset();
		resetDispatchAvailabilityState();
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-probes after the cooldown and reports the tool available again", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(timeoutResult());
		const checker = createAvailabilityChecker("slowtool");

		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(checker.getOutcome(process.cwd())).toBe("transient");

		// Inside the cooldown the verdict is reused — no probe storm.
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1);

		// After the cooldown the seam must ask again. On current (pre-fix) code
		// the cached `false` is permanent and this stays false forever.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(okResult());
		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(2);
		expect(checker.getOutcome(process.cwd())).toBe("success");
		expect(checker.getCommand(process.cwd())).toBe("slowtool");
	});

	it("still latches a genuine missing tool and never re-probes it", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(missingResult());
		const checker = createAvailabilityChecker("absenttool");

		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(checker.getOutcome(process.cwd())).toBe("missing");

		vi.setSystemTime(new Date(Date.now() + 10 * TRANSIENT_BASE_COOLDOWN_MS));
		expect(await checker.isAvailableAsync(process.cwd())).toBe(false);
		expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(checker.getVerdict(process.cwd())).toMatchObject({
			outcome: "missing",
			cause: "not-found",
			latched: true,
			retryAtMs: 0,
		});
	});

	it("escalates the cooldown so a sick machine is not re-probed every call", () => {
		expect(transientRetryDelayMs(1, "probe-timeout")).toBe(
			TRANSIENT_BASE_COOLDOWN_MS,
		);
		expect(transientRetryDelayMs(2, "probe-timeout")).toBe(
			TRANSIENT_BASE_COOLDOWN_MS * 2,
		);
		expect(transientRetryDelayMs(50, "probe-timeout")).toBe(300_000);
		// A host stall is not evidence about the tool, so its retry stays short
		// and never escalates.
		expect(transientRetryDelayMs(7, "host-stall")).toBe(HOST_STALL_COOLDOWN_MS);
	});

	it("writes one availability decision record per verdict", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue(timeoutResult());
		const checker = createAvailabilityChecker("telemetrytool", "", ["--version"], {
			probeTimeout: 1500,
		});

		await checker.isAvailableAsync(process.cwd());
		await checker.isAvailableAsync(process.cwd());

		// One decision, not one per call: the record marks a decision, not a hit.
		expect(decisions()).toHaveLength(1);
		expect(decisions()[0]).toMatchObject({
			type: "phase",
			phase: "availability_decision",
			metadata: {
				tool: "telemetrytool",
				verdict: "unavailable",
				outcome: "transient",
				cause: "probe-timeout",
				latched: false,
				retryAfterMs: TRANSIENT_BASE_COOLDOWN_MS,
				budgetMs: 1500,
			},
		});
		expect(decisions()[0].metadata.hostStallMs).toBeTypeOf("number");
	});

	it("resolves through a fastPath without spawning, and says so in telemetry", async () => {
		const safeSpawnMod = await import("../../../../clients/safe-spawn.js");
		const checker = createAvailabilityChecker("fasttool", "", ["--version"], {
			fastPath: () => "/managed/bin/fasttool",
		});

		expect(await checker.isAvailableAsync(process.cwd())).toBe(true);
		expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		expect(decisions()[0].metadata).toMatchObject({
			tool: "fasttool",
			verdict: "available",
			cause: "fast-path",
		});
	});
});

describe("availability policy: cause taxonomy and messages (#1467)", () => {
	it("blames the host, not the tool, when a stall overlapped the probe window", () => {
		expect(classifyProbeFailure(timeoutResult(), { hostStallMs: 0 })).toEqual({
			outcome: "transient",
			cause: "probe-timeout",
		});
		expect(classifyProbeFailure(timeoutResult(), { hostStallMs: 4618 })).toEqual({
			outcome: "transient",
			cause: "host-stall",
		});
		expect(classifyProbeFailure(missingResult(), { hostStallMs: 4618 })).toEqual({
			outcome: "missing",
			cause: "not-found",
		});
	});

	it("words a timed-out probe as a timeout, never as a missing install", () => {
		const transient = describeUnavailability({
			tool: "Knip",
			installHint: "npm install -D knip",
			outcome: "transient",
			cause: "probe-timeout",
			elapsedMs: 5528,
			retryAfterMs: 30_000,
		});
		expect(transient).toContain("timed out");
		expect(transient).toContain("5528ms");
		expect(transient).not.toContain("Install with");

		const missing = describeUnavailability({
			tool: "Knip",
			installHint: "npm install -D knip",
			outcome: "missing",
			cause: "not-found",
		});
		expect(missing).toBe("Knip not available. Install with: npm install -D knip");
	});

	it("names the host stall in the message when the loop, not the tool, stalled", () => {
		const message = describeUnavailability({
			tool: "Knip",
			installHint: "npm install -D knip",
			outcome: "transient",
			cause: "host-stall",
			elapsedMs: 5528,
		});
		expect(message).toContain("event loop stalled");
		expect(message).not.toContain("Install with");
	});

	it("measures a synchronous host block against the probe window", () => {
		vi.useRealTimers();
		const sampler = startHostStallSampler(50);
		const until = Date.now() + 600;
		while (Date.now() < until) {
			// Deliberate synchronous block: this is exactly what expires a
			// host-side probe budget while the child is still healthy.
		}
		expect(sampler.stop()).toBeGreaterThan(400);
	});

	// The test above never exercises the interval: nothing fires during a
	// synchronous block, so its whole figure comes from the tail computed in
	// stop(). Zeroing the interval's accumulation therefore leaves it green,
	// which would retire the sampler's entire reason for existing — and with
	// it the host-stall vs probe-timeout split that decides whether a verdict
	// latches. Here the loop RECOVERS before stop(), so the tail is negligible
	// and the figure can only come from the interval observing its own
	// lateness.
	it("attributes a stall the loop recovered from before the probe settled", async () => {
		vi.useRealTimers();
		const sampler = startHostStallSampler(50);
		const until = Date.now() + 400;
		while (Date.now() < until) {
			// Same deliberate block, but the sampler keeps running afterwards.
		}
		// Let the loop run quietly: the first tick after the block reports ~400ms
		// of lateness, and subsequent ticks are on time, so `last` ends up fresh.
		await new Promise((r) => setTimeout(r, 200));
		const stallMs = sampler.stop();
		expect(stallMs).toBeGreaterThan(300);
	});
});

describe("availability latch: shared client-side memo (#1467)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns null (re-probe) once a transient verdict's cooldown expires", () => {
		const latch = createAvailabilityLatch();
		expect(latch.read()).toBeNull();

		const delay = latch.noteUnavailable("transient", "probe-timeout");
		expect(delay).toBe(TRANSIENT_BASE_COOLDOWN_MS);
		expect(latch.read()).toBe(false);

		vi.setSystemTime(new Date(Date.now() + delay + 1));
		expect(latch.read()).toBeNull();
	});

	it("keeps a durable verdict for the whole session", () => {
		const latch = createAvailabilityLatch();
		expect(latch.noteUnavailable("missing", "not-found")).toBe(0);
		vi.setSystemTime(new Date(Date.now() + 3_600_000));
		expect(latch.read()).toBe(false);
		expect(latch.getCause()).toBe("not-found");
	});

	it("clears transient escalation once the tool answers", () => {
		const latch = createAvailabilityLatch();
		latch.noteUnavailable("transient", "probe-timeout");
		latch.noteAvailable();
		expect(latch.read()).toBe(true);
		expect(latch.noteUnavailable("transient", "probe-timeout")).toBe(
			TRANSIENT_BASE_COOLDOWN_MS,
		);
	});
});
