/**
 * symbol_search pi tool (#348) — cold (available:false + hint + background
 * build kicked once) and warm (ranked results) paths, per the #517-slimmed
 * payload (startLine/endLine, no per-hit `read` block, no repeated path array).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_SNAPSHOT_VERSION, saveProjectSnapshot } from "../../clients/project-snapshot.js";
import { buildWordIndex, serializeWordIndex, _resetWordIndexBuildGuardForTests } from "../../clients/word-index.js";
import { createSymbolSearchTool } from "../../tools/symbol-search.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

afterEach(() => {
	_resetWordIndexBuildGuardForTests();
});

describe("symbol_search tool", () => {
	it("cold path: returns available:false with an actionable hint and kicks off a background build", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-cold-");
		try {
			createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) { return id; }",
			);
			const tool = createSymbolSearchTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ query: "authenticate user" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({ available: false, query: "authenticate user" });
			expect(String((result.details as { hint?: string }).hint)).toMatch(/background|retry/i);
			expect(String(result.content[0]?.text)).toMatch(/background|retry/i);

			// The cold query kicked off a bounded background build (#348 decision 3) —
			// never blocking THIS call, but the index should show up shortly after.
			const { loadProjectSnapshot } = await import("../../clients/project-snapshot.js");
			await vi.waitFor(
				() => {
					const snapshot = loadProjectSnapshot(env.tmpDir);
					expect(snapshot?.wordIndex).toBeDefined();
				},
				{ timeout: 5000 },
			);
		} finally {
			env.cleanup();
		}
	}, 10_000);

	it("warm path: returns ranked results with startLine/endLine, no per-hit read block, path relative to cwd", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-warm-");
		try {
			const authFile = createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) {\n  return id;\n}\n",
			);
			const index = buildWordIndex([
				{ path: authFile, content: "export function authenticateUser(id) {\n  return id;\n}\n" },
			]);
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: serializeWordIndex(index),
			});

			const tool = createSymbolSearchTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ query: "authenticate user" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({ available: true, count: 1 });

			const text = String(result.content[0]?.text);
			const jsonStart = text.indexOf("{");
			const payload = JSON.parse(text.slice(jsonStart)) as {
				available: boolean;
				query: string;
				results: Array<{
					file: string;
					score: number;
					hits: number;
					startLine: number;
					endLine: number;
					read?: unknown;
					lines?: unknown;
				}>;
			};
			expect(payload.available).toBe(true);
			expect(payload.results).toHaveLength(1);
			const hit = payload.results[0];
			expect(hit.file.replace(/\\/g, "/")).toBe("src/auth.ts"); // relative to cwd, not repeated/absolute
			expect(hit.startLine).toBeGreaterThan(0);
			expect(hit.endLine).toBe(hit.startLine); // single-line span (no fabricated full-file range)
			// #517 conformity: no per-hit `read` block, no raw `lines[]` array on the wire.
			expect(hit.read).toBeUndefined();
			expect(hit.lines).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("warm path with no matches returns available:true, empty results, not an error", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-nomatch-");
		try {
			const index = buildWordIndex([
				{ path: "src/widget.ts", content: "export function renderWidget() {}" },
			]);
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: serializeWordIndex(index),
			});

			const tool = createSymbolSearchTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ query: "kubernetes helm chart" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({ available: true, count: 0 });
		} finally {
			env.cleanup();
		}
	});
});
