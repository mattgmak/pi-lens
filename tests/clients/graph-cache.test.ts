import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getLastGraphBuildInfo,
} from "../../clients/review-graph/builder.js";

// Mock out the expensive file system scanning — we only care about cache behaviour
vi.mock("../../clients/scan-utils.js", () => ({
	getSourceFiles: vi.fn().mockReturnValue([]),
}));

describe("buildOrUpdateGraph — Promise dedup cache", () => {
	const dirs: string[] = [];

	beforeEach(() => {
		clearReviewGraphWorkspaceCache();
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-graph-cache-"));
		dirs.push(dir);
		return dir;
	}

	it("returns the same Promise for identical cwd+changedFiles", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(p1).toBe(p2);
		await p1;
	});

	it("normalises changedFiles order — same promise regardless of sort order", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(
			cwd,
			[path.join(cwd, "a.ts"), path.join(cwd, "b.ts")],
			facts,
		);
		const p2 = buildOrUpdateGraph(
			cwd,
			[path.join(cwd, "b.ts"), path.join(cwd, "a.ts")],
			facts,
		);
		expect(p1).toBe(p2);
		await p1;
	});

	it("returns distinct Promises for different changedFiles", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "b.ts")], facts);
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
	});

	it("returns distinct Promises for different cwd values", async () => {
		const facts = new FactStore();
		const p1 = buildOrUpdateGraph(
			tmpDir(),
			[path.join(tmpDir(), "x.ts")],
			facts,
		);
		const p2 = buildOrUpdateGraph(
			tmpDir(),
			[path.join(tmpDir(), "x.ts")],
			facts,
		);
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
	});

	it("clearGraphCache() forces a fresh build for the same key", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const p1 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		await p1;
		clearGraphCache();
		const p2 = buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(p1).not.toBe(p2);
		await p2;
	});

	it("reuses the workspace graph when source signature is unchanged", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		await buildOrUpdateGraph(cwd, [path.join(cwd, "a.ts")], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false);
		clearGraphCache();
		await buildOrUpdateGraph(cwd, [path.join(cwd, "b.ts")], facts);
		expect(getLastGraphBuildInfo()).toEqual({
			reused: true,
			mode: "cached",
			graphChanged: false,
			seqFastpathFallback: undefined,
		});
	});

	it("reuses the cached graph when mtime drifts but content is unchanged (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const file = path.join(cwd, "drift.ts");
		fs.writeFileSync(file, "export function driftExample() {\n\treturn 1;\n}\n");

		await buildOrUpdateGraph(cwd, [file], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false); // full build

		// Bump mtime into the future WITHOUT changing content → size/mtime
		// signature differs, but the content hash matches.
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(file, future, future);

		clearGraphCache(); // drop the promise-dedup cache so the call re-executes
		// changedFiles=[] — the caller did NOT declare drift.ts changed. Pre-#202
		// this fell through to a full rebuild; now the content-hash confirm proves
		// nothing changed and the cached graph is reused.
		await buildOrUpdateGraph(cwd, [], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(true);
		expect(info.mode).toBe("cached");
	});

	it("stamps buildGeneration — no-op builds carry it forward, content changes mint a new one (#459)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const file = path.join(cwd, "gen.ts");
		fs.writeFileSync(file, "export function genA() {\n\treturn 1;\n}\n");

		const g1 = await buildOrUpdateGraph(cwd, [file], facts);
		expect(g1.buildGeneration).toBeDefined();

		// Unchanged content → cache-hit build returns a fresh clone with the SAME
		// stamp, so derived-data caches (reverse-deps index) can prove reusability.
		clearGraphCache();
		const g2 = await buildOrUpdateGraph(cwd, [file], facts);
		expect(getLastGraphBuildInfo().mode).toBe("cached");
		expect(g2.buildGeneration).toBe(g1.buildGeneration);

		// A graph-mutating build (here: full rebuild after a workspace-cache clear)
		// mints a NEW stamp. (The incremental/content-change paths are covered with
		// real files in review-graph-seq-fastpath.test.ts — this harness mocks the
		// source walk, so content edits are invisible to the signature here.)
		clearReviewGraphWorkspaceCache();
		clearGraphCache();
		const g3 = await buildOrUpdateGraph(cwd, [file], facts);
		expect(getLastGraphBuildInfo().mode).toBe("full");
		expect(g3.buildGeneration).toBeDefined();
		expect(g3.buildGeneration).not.toBe(g1.buildGeneration);
	});

	it("resolves to a ReviewGraph with version and builtAt fields", async () => {
		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(tmpDir(), [], facts);
		expect(graph).toHaveProperty("version");
		expect(graph).toHaveProperty("builtAt");
	});

	it("incrementally adds a newly-created file instead of a full rebuild (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const a = path.join(cwd, "a.ts");
		fs.writeFileSync(a, "export function alphaSymbol() {\n\treturn 1;\n}\n");
		await buildOrUpdateGraph(cwd, [a], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false); // full build

		// A new sibling file appears — pre-#202 the differing file COUNT bailed to
		// a full whole-repo rebuild; now it's an incremental add.
		const b = path.join(cwd, "b.ts");
		fs.writeFileSync(b, "export function bravoSymbol() {\n\treturn 2;\n}\n");

		clearGraphCache(); // drop promise-dedup; keep the warm workspace cache
		const graph = await buildOrUpdateGraph(cwd, [b], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(true);
		expect(info.mode).toBe("incremental"); // NOT a full rebuild
		expect(
			[...graph.nodes.values()].some((n) =>
				n.symbolName?.includes("bravoSymbol"),
			),
		).toBe(true);
	});

	it("incrementally updates a file that changed on disk outside the edit set (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const a = path.join(cwd, "a.ts");
		const b = path.join(cwd, "b.ts");
		fs.writeFileSync(a, "export function alphaSymbol() {\n\treturn 1;\n}\n");
		fs.writeFileSync(b, "export function bravoOldName() {\n\treturn 2;\n}\n");
		await buildOrUpdateGraph(cwd, [a], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false);

		// b changes on disk, but the caller only declares `a` changed. The dropped
		// `.every(in changedSet)` guard used to force a full rebuild here.
		fs.writeFileSync(b, "export function bravoNewName() {\n\treturn 3;\n}\n");
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(b, future, future);

		clearGraphCache();
		const graph = await buildOrUpdateGraph(cwd, [a], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(true);
		expect(info.mode).toBe("incremental");
		const names = [...graph.nodes.values()].map((n) => n.symbolName ?? "");
		expect(names.some((n) => n.includes("bravoNewName"))).toBe(true);
		expect(names.some((n) => n.includes("bravoOldName"))).toBe(false);
	});

	it("falls back to a full rebuild when a file is removed (#202)", async () => {
		const facts = new FactStore();
		const cwd = tmpDir();
		const a = path.join(cwd, "a.ts");
		const b = path.join(cwd, "b.ts");
		fs.writeFileSync(a, "export function alphaSymbol() {\n\treturn 1;\n}\n");
		fs.writeFileSync(b, "export function bravoSymbol() {\n\treturn 2;\n}\n");
		await buildOrUpdateGraph(cwd, [a], facts);
		expect(getLastGraphBuildInfo().reused).toBe(false);

		// A removal must prune nodes/edges — incremental update doesn't apply, so
		// the helper bails and the caller does a correct full rebuild.
		fs.rmSync(b);

		clearGraphCache();
		const graph = await buildOrUpdateGraph(cwd, [a], facts);
		const info = getLastGraphBuildInfo();
		expect(info.reused).toBe(false);
		expect(info.mode).toBe("full");
		expect(
			[...graph.nodes.values()].some((n) =>
				n.symbolName?.includes("bravoSymbol"),
			),
		).toBe(false);
	});
});
