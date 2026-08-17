import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	loadProjectSnapshot,
	saveProjectSnapshot,
	saveRuntimeProjectSnapshot,
} from "../../clients/project-snapshot.js";
import {
	buildReverseDependencyIndexFromGraph,
	buildReverseDependencyIndexFromSnapshot,
	getAffectedFilesFromIndex,
	getReverseDepsFromIndex,
	loadReverseDependencyIndexFromSnapshot,
	patchReverseDependencyIndex,
	writeReverseDependencyIndexToSnapshot,
} from "../../clients/reverse-deps.js";
import { buildOrUpdateGraph } from "../../clients/review-graph/service.js";
import type {
	ReviewGraph,
	ReviewGraphEdge,
	ReviewGraphNode,
} from "../../clients/review-graph/types.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("reverse dependency index", () => {
	it("patches random single-file mutations equivalently to a full rebuild", {
		timeout: 30_000,
	}, () => {
		let state = 0x939_0003;
		const random = () => {
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
			return state / 0x1_0000_0000;
		};
		const cwd = normalizeMapKey(path.resolve("reverse-deps-random"));
		const files = Array.from({ length: 24 }, (_, index) =>
			normalizeMapKey(path.join(cwd, `file-${index}.ts`)),
		);
		const targetsByFile = new Map<string, Set<string>>(
			files.map((file) => [file, new Set<string>()]),
		);
		const graphFromState = (): ReviewGraph => {
			const nodes = new Map<string, ReviewGraphNode>();
			const edges: ReviewGraphEdge[] = [];
			const fileNodes = new Map<string, string>();
			for (const file of targetsByFile.keys()) {
				const id = `file:${file}`;
				nodes.set(id, { id, kind: "file", language: "typescript", filePath: file });
				fileNodes.set(file, id);
			}
			for (const [file, targets] of targetsByFile) {
				for (const target of targets) {
					if (!targetsByFile.has(target) || target === file) continue;
					edges.push({
						from: `file:${file}`,
						to: `file:${target}`,
						kind: "imports",
					});
				}
			}
			return {
				version: "test",
				builtAt: "test",
				nodes,
				edges,
				edgesByFrom: new Map(),
				edgesByTo: new Map(),
				fileNodes,
				symbolNodesByFile: new Map(),
				changedSymbolsByFile: new Map(),
			};
		};

		let patched = buildReverseDependencyIndexFromGraph({
			cwd,
			graph: graphFromState(),
		});
		for (let iteration = 0; iteration < 50; iteration++) {
			const file = files[Math.floor(random() * files.length)];
			const prior = [...(targetsByFile.get(file) ?? [])].sort();
			const next = new Set(prior);
			const target = files[Math.floor(random() * files.length)];
			if (next.has(target)) next.delete(target);
			else if (target !== file) next.add(target);
			targetsByFile.set(file, next);
			patched = patchReverseDependencyIndex(patched, [
				{
					filePath: file,
					existedBefore: true,
					existsAfter: true,
					priorTargets: prior,
					newTargets: [...next].sort(),
				},
			]);
			const rebuilt = buildReverseDependencyIndexFromGraph({
				cwd,
				graph: graphFromState(),
			});
			rebuilt.generatedAt = patched.generatedAt;
			expect(patched).toEqual(rebuilt);
		}
	});

	it("builds reverse dependency lookups from the review graph", async () => {
		const env = setupTestEnvironment("pi-lens-reverse-deps-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const alpha = 1;\n",
			);
			const bPath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				"import { alpha } from './a';\nexport const beta = alpha;\n",
			);
			const cPath = createTempFile(
				env.tmpDir,
				"src/c.ts",
				"import { beta } from './b';\nexport const gamma = beta;\n",
			);

			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[aPath],
				new FactStore(),
			);
			const index = buildReverseDependencyIndexFromGraph({
				cwd: env.tmpDir,
				graph,
			});

			expect(getReverseDepsFromIndex(index, aPath)).toEqual([
				normalizeMapKey(bPath),
			]);
			expect(getAffectedFilesFromIndex(index, aPath, 2)).toEqual([
				normalizeMapKey(bPath),
				normalizeMapKey(cPath),
			]);
		} finally {
			env.cleanup();
		}
	});

	it("persists and reloads reverse dependencies through the project snapshot", async () => {
		const env = setupTestEnvironment("pi-lens-reverse-deps-snapshot-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const alpha = 1;\n",
			);
			const bPath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				"import { alpha } from './a';\nexport const beta = alpha;\n",
			);
			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[aPath],
				new FactStore(),
			);
			const index = buildReverseDependencyIndexFromGraph({
				cwd: env.tmpDir,
				graph,
				seq: 3,
			});
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 3,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			});

			expect(
				writeReverseDependencyIndexToSnapshot({ cwd: env.tmpDir, index }),
			).toBe(true);
			const snapshot = loadProjectSnapshot(env.tmpDir);
			expect(snapshot?.reverseDeps[normalizeMapKey(aPath)]).toEqual([
				normalizeMapKey(bPath),
			]);
			expect(snapshot?.files[normalizeMapKey(bPath)]?.imports).toEqual([
				normalizeMapKey(aPath),
			]);

			const loaded = loadReverseDependencyIndexFromSnapshot({
				cwd: env.tmpDir,
				currentProjectSeq: 3,
			});
			expect(loaded).not.toBeNull();
			expect(loaded?.source).toBe("project-snapshot");
			expect(loaded && getReverseDepsFromIndex(loaded, aPath)).toEqual([
				normalizeMapKey(bPath),
			]);
			expect(
				loadReverseDependencyIndexFromSnapshot({
					cwd: env.tmpDir,
					currentProjectSeq: 4,
				}),
			).toBeNull();
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("preserves cached reverse dependencies when saving runtime snapshots", () => {
		const env = setupTestEnvironment("pi-lens-reverse-deps-preserve-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const aPath = normalizeMapKey(path.join(env.tmpDir, "src/a.ts"));
			const bPath = normalizeMapKey(path.join(env.tmpDir, "src/b.ts"));
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 5,
				files: {
					[bPath]: {
						path: bPath,
						mtimeMs: 1,
						size: 10,
						imports: [aPath],
						lastSeq: 0,
					},
				},
				symbols: {},
				reverseDeps: { [aPath]: [bPath] },
				cachedExports: [],
			});
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			runtime.cachedExports.set("alpha", aPath);

			saveRuntimeProjectSnapshot({ cwd: env.tmpDir, runtime });
			const snapshot = loadProjectSnapshot(env.tmpDir);
			expect(snapshot?.cachedExports).toEqual([["alpha", aPath]]);
			expect(
				buildReverseDependencyIndexFromSnapshot(snapshot!)?.importedBy,
			).toEqual({
				[aPath]: [bPath],
				[bPath]: [],
			});
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});
