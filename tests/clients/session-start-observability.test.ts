import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);
vi.mock("../../clients/latency-logger.js", () => ({
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

import { logConcurrentSessionBind } from "../../clients/session-start-observability.js";

describe("session-start observability", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
	});

	it("a concurrent secondary emits only its bind record", () => {
		logConcurrentSessionBind({
			secondaryCount: 1,
			sessionReason: "fork",
			sameCwd: true,
		});

		expect(latencyEntries).toEqual([
			{
				type: "phase",
				filePath: "<pi-lens>",
				phase: "concurrent_session_bind",
				durationMs: 0,
				metadata: {
					secondaryCount: 1,
					sessionReason: "fork",
					sameCwd: true,
				},
			},
		]);
	});
});
