/**
 * collectSourceFilesForWarmup (#250) — the warmup language-profile source walk.
 *
 * Guards the two failure modes behind a multi-hour home-dir scan: an UNCAPPED
 * walk, and the walk drifting outside its root. The runaway was triggered when
 * the warmup path ignored startup-scan's canWarmCaches=false and rooted this walk
 * at an ancestor ($HOME); the guard fix lives in runtime-session, and this caps
 * the walk as defense-in-depth + locks in root-confinement.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { collectSourceFilesForWarmup } from "../../clients/language-profile.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("collectSourceFilesForWarmup (#250)", () => {
	it("hard-caps the number of source files collected", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-cap-");
		try {
			for (let i = 0; i < 10; i++) {
				createTempFile(env.tmpDir, `f${i}.ts`, "export const x = 1;\n");
			}
			const files = await collectSourceFilesForWarmup(env.tmpDir, 3);
			expect(files).toHaveLength(3);
		} finally {
			env.cleanup();
		}
	});

	it("stays confined to the root — never walks a sibling/parent tree", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-root-");
		try {
			const root = path.join(env.tmpDir, "project");
			fs.mkdirSync(root, { recursive: true });
			createTempFile(root, "a.ts", "export const a = 1;\n");
			createTempFile(root, "sub/b.ts", "export const b = 1;\n");
			// A sibling OUTSIDE the root — the #250 escape would have swept this in.
			createTempFile(env.tmpDir, "outside/escape.ts", "export const z = 1;\n");

			const files = (await collectSourceFilesForWarmup(root)).map((f) =>
				f.replace(/\\/g, "/"),
			);

			expect(files.some((f) => f.endsWith("/project/a.ts"))).toBe(true);
			expect(files.some((f) => f.endsWith("/project/sub/b.ts"))).toBe(true);
			expect(files.some((f) => f.includes("/outside/"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("excludes node_modules / ignored directories", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-ignore-");
		try {
			createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
			createTempFile(
				env.tmpDir,
				"node_modules/dep/index.ts",
				"export const d = 1;\n",
			);
			const files = (await collectSourceFilesForWarmup(env.tmpDir)).map((f) =>
				f.replace(/\\/g, "/"),
			);
			expect(files.some((f) => f.endsWith("/a.ts"))).toBe(true);
			expect(files.some((f) => f.includes("/node_modules/"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
