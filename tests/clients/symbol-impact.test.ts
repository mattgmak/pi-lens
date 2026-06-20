import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { symbolImpact } from "../../clients/lens-engine.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// symbolImpact is read-only (#260): it consumes the cached review graph via
// getCachedReviewGraph and NEVER builds. Building from this read path (empty
// changedFiles + fresh FactStore) defeats the incremental build and races the
// edit pipeline → OOM. Production warms the cache via the edit pipeline / scan.
async function warmGraph(cwd: string): Promise<void> {
	await buildOrUpdateGraph(cwd, [], new FactStore());
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache(); // isolate the module-global graph cache
});

function makeEnv() {
	const env = setupTestEnvironment("pi-lens-impact-");
	cleanups.push(env.cleanup);
	return env;
}

describe("symbolImpact — read-only over the cached review graph (#260)", () => {
	it("returns available:false on a cold cache WITHOUT building", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo(): number {\n  return 1;\n}\n",
		);
		createTempFile(
			env.tmpDir,
			"b.ts",
			'import { foo } from "./a.js";\nexport const r = foo();\n',
		);
		// No warmGraph() → the cache is cold. symbolImpact must NOT build it.
		const result = await symbolImpact("a.ts", env.tmpDir);
		expect(result.available).toBe(false);
		expect(result.hits).toHaveLength(0);
		expect(result.seedFile.endsWith("a.ts")).toBe(true);
	});

	it("resolves incoming impact from the warmed cache", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo(): number {\n  return 1;\n}\n",
		);
		createTempFile(
			env.tmpDir,
			"b.ts",
			[
				'import { foo } from "./a.js";',
				"export function callsFoo(): number {",
				"  return foo();",
				"}",
			].join("\n"),
		);
		await warmGraph(env.tmpDir);
		const result = await symbolImpact("a.ts", env.tmpDir);
		expect(result.available).toBe(true);
		expect(result.hits.some((h) => h.file.endsWith("b.ts"))).toBe(true);
	});
});
