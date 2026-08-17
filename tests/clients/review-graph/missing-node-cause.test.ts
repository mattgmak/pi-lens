/**
 * #1445: `computeImpactCascade` returns `indeterminate: { reason:
 * "missing_node" }` whenever the changed file has no node in the graph — but
 * that has two causes that read identically to the caller and mean opposite
 * things:
 *
 *  - genuinely missing: the graph SHOULD know this file but doesn't (a real
 *    gap the "review graph was unavailable" advisory should keep flagging).
 *  - excluded by role: the file's role (test, #260) is refused at every
 *    graph-admission chokepoint by design — `builder.ts`'s own predicate,
 *    `detectFileRole(file) === "test"` (see `tests-free-graph.test.ts`'s
 *    #1080 baseline). A test edit not cascading is expected behavior, not a
 *    graph failure.
 *
 * Before the fix, both causes collapsed onto the same `missing_node` reason,
 * so a healthy graph (2615 nodes in the reporting dogfood run) blamed itself
 * for every test-file edit — 19% of cascades in the observed window.
 */
import { afterEach, describe, expect, it } from "vitest";
import { detectFileRole } from "../../../clients/file-role.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import { computeImpactCascade } from "../../../clients/review-graph/service.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
});

function makeEnv(prefix = "pi-lens-missing-node-cause-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

describe("missing_node cause disambiguation (#1445)", () => {
	it("a test-file edit reports excluded_by_role, not missing_node (RED on pre-fix code)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"widget.ts",
			["export function render() {", "  return 1;", "}"].join("\n"),
		);
		const testFile = createTempFile(
			env.tmpDir,
			"widget.test.ts",
			["import { render } from './widget';", "render();"].join("\n"),
		);

		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(env.tmpDir, [], facts);

		// Baseline (#1080): the healthy graph really did build and really does
		// NOT contain the test file — this is not a degraded/cold graph.
		expect(graph.nodes.size).toBeGreaterThan(0);
		expect(graph.fileNodes.has(normalizeMapKey(testFile))).toBe(false);

		const impact = computeImpactCascade(graph, testFile, env.tmpDir);
		expect(impact.indeterminate?.reason).toBe("excluded_by_role");
		expect(impact.indeterminate?.reason).not.toBe("missing_node");
	});

	it("a genuinely-missing source file still reports missing_node (no regression)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"known.ts",
			["export const known = 1;", ""].join("\n"),
		);

		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(env.tmpDir, [], facts);
		expect(graph.nodes.size).toBeGreaterThan(0);

		// A source-role file that was never part of the build (outside cwd, so
		// it never enters the graph) — an honest gap, not a role exclusion.
		const unknownFile = env.tmpDir.replace(/\\/g, "/") + "/unrelated-src.ts";
		expect(detectFileRole(unknownFile)).not.toBe("test");
		expect(graph.fileNodes.has(normalizeMapKey(unknownFile))).toBe(false);

		const impact = computeImpactCascade(graph, unknownFile, env.tmpDir);
		expect(impact.indeterminate?.reason).toBe("missing_node");
	});

	// #894 pattern: the exclusion decision must derive from the SAME predicate
	// builder.ts uses at its own graph-admission chokepoints
	// (`detectFileRole(file) === "test"`), never a second hand-rolled role
	// list. Sweep a representative set of role-classified filenames and assert
	// the two seams agree — a role builder.ts would refuse always reports
	// excluded_by_role here, and a role builder.ts would admit (but that never
	// actually entered THIS graph) always reports missing_node.
	it.each([
		["foo.test.ts", "test"],
		["foo.spec.ts", "test"],
		["tests/foo.ts", "test"],
		["spec_foo.py", "test"],
		["plain-source.ts", "source"],
		["mod.rs", "init"],
	] as const)(
		"agrees with detectFileRole(%s) === %s on the excluded_by_role/missing_node split",
		async (relPath, expectedRole) => {
			const env = makeEnv(`pi-lens-missing-node-cause-sweep-`);
			createTempFile(env.tmpDir, "anchor.ts", "export const anchor = 1;\n");
			const facts = new FactStore();
			const graph = await buildOrUpdateGraph(env.tmpDir, [], facts);

			const absPath = `${env.tmpDir.replace(/\\/g, "/")}/${relPath}`;
			expect(detectFileRole(absPath)).toBe(expectedRole);
			expect(graph.fileNodes.has(normalizeMapKey(absPath))).toBe(false);

			const impact = computeImpactCascade(graph, absPath, env.tmpDir);
			const expectedReason =
				expectedRole === "test" ? "excluded_by_role" : "missing_node";
			expect(impact.indeterminate?.reason).toBe(expectedReason);
		},
	);
});
