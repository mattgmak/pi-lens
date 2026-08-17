import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const latencyEntries: Array<Record<string, unknown>> = [];
vi.mock("../../clients/latency-logger.js", async (importActual) => {
	const actual = await importActual<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency: (entry: Record<string, unknown>) => latencyEntries.push(entry) };
});

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(async () => ({
		output: "no blockers",
		hasBlockers: false,
		isError: false,
		fileModified: false,
		cascadePromise: undefined,
	})),
}));

describe("runtime event flow", () => {
	it("runs the real turn-end madge batch and carries its result metadata (#1251)", async () => {
		const env = setupTestEnvironment("pi-lens-madge-turn-end-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const filePath = path.join(env.tmpDir, "src", "cycle.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const value = 1;\n");
		const dbg = vi.fn();
		latencyEntries.length = 0;
		try {
			cacheManager.addModifiedRange(filePath, { start: 1, end: 1 }, true, env.tmpDir);
			const stats = {
				requested: 1, missing: 0, cacheHits: 0, spawned: 1, failed: 0,
				commandKind: "npx", resolveMs: 3,
				targets: [{ file: "src/cycle.ts", durationMs: 125, ok: true }],
				targetsTruncated: false,
			};
			const checkFilesBatch = vi.fn(async () => ({
				results: new Map([[path.resolve(filePath), {
					hasCircular: true, circular: [{ file: path.resolve(filePath), path: path.resolve(filePath) }],
					checked: true, cacheHit: false,
				}]]),
				stats,
			}));

			await handleTurnEnd({
				ctxCwd: env.tmpDir, getFlag: () => false, dbg, runtime, cacheManager,
				knipClient: { ensureAvailable: async () => false, analyze: async () => EMPTY_KNIP_RESULT },
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => true, checkFilesBatch } as any,
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {}, resetFormatService: () => {},
			} as any);

			expect(checkFilesBatch).toHaveBeenCalledWith([path.resolve(filePath)], env.tmpDir);
			expect(dbg).toHaveBeenCalledWith(expect.stringContaining("circular dependency note"));
			const madge = latencyEntries.find((entry) => entry.phase === "madge");
			expect(madge?.metadata).toEqual(stats);
		} finally {
			env.cleanup();
		}
	});

	it("flows session_start -> tool_result -> turn_end -> context", async () => {
		const env = setupTestEnvironment("pi-lens-event-flow-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const notify = vi.fn();

		try {
			const filePath = path.join(env.tmpDir, "src", "flow.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const value = 1;\n");

			await handleSessionStart({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				notify,
				dbg: () => {},
				log: () => {},
				runtime,
				metricsClient: { reset: () => {} },
				cacheManager,
				todoScanner: { scanDirectory: () => ({ items: [] }) },
				astGrepClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
					scanExports: async () => new Map(),
				},
				biomeClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				ruffClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				knipClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				jscpdClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				deadCodeClients: [],
				depChecker: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				testRunnerClient: { detectRunner: () => null, runTestFile: () => ({}) },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				ensureTool: async () => null,
				cleanStaleTsBuildInfo: () => [],
				resetDispatchBaselines: () => {},
				resetLSPService: () => {},
			} as any);

			await handleToolResult({
				event: {
					toolName: "write",
					input: { path: filePath },
					details: {},
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			// cascadeRun is undefined (mock returns undefined) — no accumulation
			expect(runtime.consumeCascadeRuns()).toHaveLength(0);

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			// No cascade results or knip blockers — turn_end clears state
			const firstContext = consumeTurnEndFindings(cacheManager, env.tmpDir);
			expect(firstContext).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
