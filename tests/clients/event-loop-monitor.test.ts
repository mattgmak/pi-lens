import { afterEach, describe, expect, it } from "vitest";
import {
	_stopEventLoopMonitorForTest,
	getEventLoopStats,
	resetEventLoopMonitor,
	shouldLogWorstBlock,
	startEventLoopMonitor,
} from "../../clients/event-loop-monitor.js";

// Note: the actual *capture* of a synchronous block is Node's native
// `monitorEventLoopDelay` (its libuv timer is unreliable inside vitest's worker,
// but verified manually: a 200ms busy-loop yields max≈200ms on a live loop).
// These cover our wrapper's contract — lifecycle, finite-stat conversion, reset.

afterEach(() => {
	_stopEventLoopMonitorForTest();
});

const settle = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("event-loop-monitor", () => {
	it("returns undefined before it is started", () => {
		expect(getEventLoopStats()).toBeUndefined();
	});

	it("reports finite occupancy stats once started", async () => {
		startEventLoopMonitor(10);
		await settle(40); // let it sample a few intervals
		const s = getEventLoopStats();
		expect(s).toBeDefined();
		expect(Number.isFinite(s?.maxMs)).toBe(true);
		expect(Number.isFinite(s?.p99Ms)).toBe(true);
		expect(Number.isFinite(s?.meanMs)).toBe(true);
		expect(s?.maxMs).toBeGreaterThanOrEqual(0);
	});

	it("reset does not throw and keeps stats queryable", async () => {
		startEventLoopMonitor(10);
		await settle(20);
		resetEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
	});

	it("start is idempotent", () => {
		startEventLoopMonitor();
		startEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
	});

	it("_stopEventLoopMonitorForTest clears the monitor", () => {
		startEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
		_stopEventLoopMonitorForTest();
		expect(getEventLoopStats()).toBeUndefined();
	});
});

describe("shouldLogWorstBlock", () => {
	it("logs a new worst block above the floor", () => {
		expect(shouldLogWorstBlock(200, 0)).toBe(true);
	});

	it("does not log a block below the floor", () => {
		expect(shouldLogWorstBlock(40, 0)).toBe(false);
	});

	it("does not re-log a block within delta of the last logged max", () => {
		expect(shouldLogWorstBlock(210, 200)).toBe(false); // 210 ≤ 200+25
	});

	it("logs a clearly worse block beyond the delta", () => {
		expect(shouldLogWorstBlock(300, 200)).toBe(true); // 300 > 225
	});
});
