/**
 * Event-loop occupancy guard for the tool_result autofix side-effect walk
 * (#361, follow-up to #192). `snapshotProjectFiles` runs on the `tool_result`
 * pipeline path — after a formatter/fixer touches a file, pi-lens snapshots the
 * tree (before/after) to detect side-effect changes. It is a **fully
 * synchronous** `readdirSync`/`statSync` walk, bounded only by
 * `AUTOFIX_CHANGED_FILE_SCAN_LIMIT`, so at scale it holds the loop (and the TUI)
 * for its whole duration — there is no yield.
 *
 * We measure occupancy (longest sync block), NOT wall-clock duration. This guard
 * trips if the walk's sync cost grows sharply — the concrete regressions being:
 *   - directory excludes break and the walk descends `node_modules`/ignored
 *     dirs (the walk-confinement invariant), exploding the file count;
 *   - the scan cap is removed/raised so the walk no longer self-limits;
 *   - a per-file synchronous cost is added (e.g. a `readFileSync` per entry).
 *
 * Budget mirrors the source-walk occupancy suite (300ms trip-wire, `retry` to
 * soak parallel-suite load) at the same ~1.2k-file fixture weight.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotProjectFiles } from "../../clients/pipeline.js";
import {
	generateSourceTree,
	measureMaxSyncBlockMs,
} from "../support/perf-harness.js";

// A non-yielding walk at this scale is ~tens of ms locally and hundreds under
// load; 300ms catches a count-explosion / per-file-cost regression with margin.
const MAX_SYNC_BLOCK_MS = 300;
// Light enough not to starve the parallel suite, large enough that a broken
// exclude (descending node_modules) or removed cap blows the budget.
const TREE_SIZE = 1200;

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-snapshot-occupancy-"));
	generateSourceTree(tmpDir, TREE_SIZE);
}, 60_000);

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe(`tool_result snapshot walk occupancy (~${TREE_SIZE} files)`, () => {
	it(
		"snapshotProjectFiles stays under the sync-block budget",
		{ retry: 2, timeout: 30_000 },
		async () => {
			let size = 0;
			const maxBlock = await measureMaxSyncBlockMs(async () => {
				size = snapshotProjectFiles(tmpDir).size;
			});
			expect(size).toBeGreaterThan(0);
			expect(maxBlock).toBeLessThan(MAX_SYNC_BLOCK_MS);
		},
	);

	it("excludes node_modules so the walk stays bounded", () => {
		const snapshot = snapshotProjectFiles(tmpDir);
		const descended = [...snapshot.keys()].some((p) =>
			p.split(path.sep).includes("node_modules"),
		);
		// generateSourceTree seeds node_modules/pkg/*.js noise; if the walk
		// descended it, the count (and the sync block above) would balloon.
		expect(descended).toBe(false);
	});
});
