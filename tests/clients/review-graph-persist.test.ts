import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Circuit-breaker for the review-graph persist (#260): the whole-graph
// JSON.stringify on every edit turn spiked the host into a Zone OOM. These cover
// the two guards — element-count ceiling (skip) and debounce (coalesce/defer).

const cleanups: Array<() => void> = [];
afterEach(() => {
	flushReviewGraphPersistsForTests(); // drain any pending debounced write/timer
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
	// Restore the test-default synchronous persist + uncapped size.
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
	delete process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS;
});

function makeEnv() {
	const env = setupTestEnvironment("pi-lens-graph-persist-");
	cleanups.push(env.cleanup);
	return env;
}

function cachePathFor(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "review-graph.json");
}

async function waitForFile(p: string, attempts = 20): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		if (fs.existsSync(p)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return fs.existsSync(p);
}

describe("review-graph persist circuit-breaker (#260)", () => {
	it("size cap: skips the write when the graph exceeds the element ceiling", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export function foo() {\n  return 1;\n}\n");
		createTempFile(
			env.tmpDir,
			"b.ts",
			'import { foo } from "./a.js";\nexport const r = foo();\n',
		);
		const cachePath = cachePathFor(env.tmpDir);
		// A two-file project is well above 1 element (file + symbol nodes + edges).
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "1";

		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts"), path.join(env.tmpDir, "b.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		await new Promise((r) => setTimeout(r, 100)); // let any errant write land
		expect(fs.existsSync(cachePath)).toBe(false);
	});

	it("size cap: writes normally when under the ceiling", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export function foo() {\n  return 1;\n}\n");
		const cachePath = cachePathFor(env.tmpDir);
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "1000000";

		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		expect(await waitForFile(cachePath)).toBe(true);
	});

	it("debounce: defers the write until the quiet window / flush", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export function foo() {\n  return 1;\n}\n");
		const cachePath = cachePathFor(env.tmpDir);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000"; // effectively never

		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		await new Promise((r) => setTimeout(r, 60));
		// Scheduled but not yet flushed → no file on disk.
		expect(fs.existsSync(cachePath)).toBe(false);

		flushReviewGraphPersistsForTests();
		expect(await waitForFile(cachePath)).toBe(true);
	});
});
