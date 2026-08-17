/**
 * #926 durable word-index reporting, extended for #958. Verifies the shared
 * NDJSON writer forwarding + the `isTestMode()` gate, mirroring
 * latency-logger.test.ts's mock-the-writer pattern so no real file is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const writerLog = vi.hoisted(() => vi.fn());
const isTestModeRef = vi.hoisted(() => ({ value: false }));

vi.mock("../../clients/env-utils.js", () => ({
	isTestMode: () => isTestModeRef.value,
	// getMaxLogSizeMB (below) is resolved from log-cleanup, which imports
	// env-utils too; keep the surface minimal but complete for this test.
}));
vi.mock("../../clients/ndjson-logger.js", () => ({
	createNdjsonLogger: () => ({
		log: writerLog,
		append: vi.fn(),
		truncate: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
		flushSync: vi.fn(),
	}),
}));

import { logWordIndex } from "../../clients/word-index-logger.js";

describe("word-index-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
		isTestModeRef.value = false;
	});

	it("stamps ts and forwards the structured decision/coverage fields", () => {
		logWordIndex({
			phase: "incremental_refresh",
			cwd: "/proj",
			trigger: "session_start",
			indexedFileCount: 42,
			truncated: false,
			refreshed: 3,
			dropped: 1,
			skipped: 0,
			reused: 38,
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				phase: "incremental_refresh",
				cwd: "/proj",
				indexedFileCount: 42,
				refreshed: 3,
				reused: 38,
				ts: expect.any(String),
			}),
		);
	});

	it("is a no-op inside the test runner (isTestMode gate)", () => {
		isTestModeRef.value = true;
		logWordIndex({ phase: "persist_failed", cwd: "/proj", error: "boom" });
		expect(writerLog).not.toHaveBeenCalled();
	});
});
