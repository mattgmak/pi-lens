import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	PROJECT_SNAPSHOT_VERSION,
	buildProjectSnapshotFromRuntime,
	getProjectSnapshotMetaPath,
	getProjectSnapshotPath,
	hydrateRuntimeFromProjectSnapshot,
	isProjectSnapshotFresh,
	loadProjectSnapshot,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

function withProjectDataDir<T>(fn: (cwd: string) => T): T {
	const env = setupTestEnvironment("project-snapshot-");
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	try {
		return fn(path.join(env.tmpDir, "project"));
	} finally {
		if (previousDataDir === undefined) {
			delete process.env.PILENS_DATA_DIR;
		} else {
			process.env.PILENS_DATA_DIR = previousDataDir;
		}
		env.cleanup();
	}
}

describe("project snapshot", () => {
	it("builds, saves, and loads a runtime snapshot", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			runtime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
			runtime.projectRulesScan = {
				hasCustomRules: true,
				rules: [
					{
						source: "root",
						name: "AGENTS.md",
						filePath: path.join(cwd, "AGENTS.md"),
						relativePath: "AGENTS.md",
					},
				],
			};

			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);

			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(true);
			expect(fs.existsSync(getProjectSnapshotMetaPath(cwd))).toBe(true);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded).toMatchObject({
				version: PROJECT_SNAPSHOT_VERSION,
				seq: 7,
				cachedExports: [["makeThing", path.join(cwd, "src", "a.ts")]],
			});
			expect(isProjectSnapshotFresh(loaded, 7)).toBe(true);
		}));

	it("rejects wrong-version, stale, and future snapshots", () =>
		withProjectDataDir((cwd) => {
			const badPath = getProjectSnapshotPath(cwd);
			fs.mkdirSync(path.dirname(badPath), { recursive: true });
			fs.writeFileSync(
				badPath,
				JSON.stringify({
					version: 999,
					projectRoot: cwd,
					generatedAt: new Date().toISOString(),
					seq: 1,
					cachedExports: [],
				}),
			);
			expect(loadProjectSnapshot(cwd)).toBeNull();

			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(3);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			expect(isProjectSnapshotFresh(snapshot, 2)).toBe(false);
			expect(isProjectSnapshotFresh(snapshot, 4)).toBe(false);
			expect(isProjectSnapshotFresh(snapshot, 3)).toBe(true);
		}));

	it("hydrates cached exports and rules into a new runtime", () =>
		withProjectDataDir((cwd) => {
			const source = new RuntimeCoordinator();
			source.seedProjectSequence(1);
			source.cachedExports.set("fromSnapshot", path.join(cwd, "src", "a.ts"));
			source.projectRulesScan = { hasCustomRules: true, rules: [] };
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime: source,
			});

			const target = new RuntimeCoordinator();
			target.cachedExports.set("stale", path.join(cwd, "src", "old.ts"));
			hydrateRuntimeFromProjectSnapshot(target, snapshot);

			expect([...target.cachedExports.entries()]).toEqual([
				["fromSnapshot", path.join(cwd, "src", "a.ts")],
			]);
			expect(target.projectRulesScan.hasCustomRules).toBe(true);
		}));
});
