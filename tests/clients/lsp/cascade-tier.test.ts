/**
 * Tests for clients/lsp/cascade-tier.ts (#458, re-scope №2) — the tier
 * classifier, the outstanding-touch registry/reconcile logic, and the kill
 * switch. The actual "skip the in-lane wait" call site lives in
 * clients/dispatch/integration.ts and is covered by cascade-compute.test.ts;
 * this file unit-tests the standalone policy module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const registerQuietWindowTask = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
}));

vi.mock("../../../clients/quiet-window.js", () => ({
	registerQuietWindowTask,
}));

vi.mock("../../../clients/cascade-logger.js", () => ({
	logCascade: vi.fn(),
}));

vi.mock("../../../clients/latency-logger.js", () => ({
	logLatency: vi.fn(),
}));

const FILE = "C:/repo/neighbor.ts";

function server(id: string, role?: "language" | "auxiliary") {
	return { id, name: id, extensions: [".ts"], root: async () => "C:/repo", role };
}

describe("classifyCascadeWaitTier", () => {
	let mod: typeof import("../../../clients/lsp/cascade-tier.js");

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		registerQuietWindowTask.mockReset();
		mod = await import("../../../clients/lsp/cascade-tier.js");
	});

	it("classifies a push-only, silentOnClean server (typescript) as tier3-silent", () => {
		getServersForFileWithConfig.mockReturnValue([server("typescript")]);
		const snapshots = [
			{
				serverId: "typescript",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
		];
		const tier = mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any);
		expect(tier).toBe("tier3-silent");
	});

	it("classifies a pull-mode server as waits (tier 1/2, always affirmative)", () => {
		getServersForFileWithConfig.mockReturnValue([server("rust-analyzer")]);
		const snapshots = [
			{
				serverId: "rust-analyzer",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "pull" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
		];
		expect(
			mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any),
		).toBe("waits");
	});

	it("classifies a push-only server WITHOUT silentOnClean (e.g. pyright, tier 2) as waits", () => {
		getServersForFileWithConfig.mockReturnValue([server("python")]);
		const snapshots = [
			{
				serverId: "python",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
		];
		expect(
			mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any),
		).toBe("waits");
	});

	it("fails safe to waits when there's no live snapshot for the primary server yet", () => {
		getServersForFileWithConfig.mockReturnValue([server("typescript")]);
		expect(mod.classifyCascadeWaitTier({} as any, FILE, [])).toBe("waits");
	});

	it("fails safe to waits when there are no configured servers for the file", () => {
		getServersForFileWithConfig.mockReturnValue([]);
		expect(mod.classifyCascadeWaitTier({} as any, FILE, [])).toBe("waits");
	});

	it("only considers the primary (non-auxiliary) server", () => {
		getServersForFileWithConfig.mockReturnValue([
			server("typescript"),
			server("opengrep", "auxiliary"),
		]);
		const snapshots = [
			{
				serverId: "opengrep",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
			{
				serverId: "typescript",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
		];
		// The auxiliary snapshot (opengrep) must not be mistaken for the primary's.
		expect(
			mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any),
		).toBe("tier3-silent");
	});
});

describe("outstanding touch registry + reconcile", () => {
	let mod: typeof import("../../../clients/lsp/cascade-tier.js");

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		registerQuietWindowTask.mockReset();
		mod = await import("../../../clients/lsp/cascade-tier.js");
		mod._resetOutstandingCascadeTouchesForTests();
	});

	afterEach(() => {
		mod._resetOutstandingCascadeTouchesForTests();
	});

	/** Warm client whose per-file diagnostics map is given as [path, diags, ts] rows. */
	function warmClient(
		serverId: string,
		rows: Array<[string, unknown[], number]>,
	) {
		const map = new Map(
			rows.map(([p, diags, ts]) => [
				// getAllDiagnostics keys by normalizeMapKey — forward slashes.
				p.replace(/\\/g, "/"),
				{ diags, ts },
			]),
		);
		return {
			client: {
				serverId,
				getAllDiagnostics: vi.fn().mockReturnValue(map),
			},
		};
	}

	it("resolves an outstanding touch as resolved-found when THAT FILE's diagnostics published after the touch", async () => {
		const touchedAt = Date.now() - 1000;
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(
					warmClient("typescript", [
						[FILE, [{ message: "err" }], touchedAt + 500],
					]),
				),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			outcome: "resolved-found",
			diagnosticCount: 1,
		});
		// Registry is drained after reconcile.
		expect(mod._getOutstandingCascadeTouchesForTests()).toHaveLength(0);
	});

	it("resolves an outstanding touch as resolved-clean only when an empty publish for THAT FILE arrived after the touch", async () => {
		const touchedAt = Date.now() - 1000;
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(
					warmClient("typescript", [[FILE, [], touchedAt + 500]]),
				),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0]).toMatchObject({
			outcome: "resolved-clean",
			diagnosticCount: 0,
		});
	});

	it("records unresolved — NEVER clean — when nothing published for the file by settle time (#240 doctrine)", async () => {
		const touchedAt = Date.now() - 1000;
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				// Client is warm but holds NO entry for this file at all.
				.mockResolvedValue(warmClient("typescript", [])),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("records unresolved when the only per-file entry PREDATES the touch (stale publish is not an answer)", async () => {
		const touchedAt = Date.now() - 1000;
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(
					warmClient("typescript", [[FILE, [], touchedAt - 5000]]),
				),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("a sibling file's publish on the SAME client must not prove a silent neighbor clean (cross-file poisoning)", async () => {
		// Two neighbors touched on one tsserver client: A publishes findings,
		// B stays silent. Any client-wide freshness signal (e.g. the client's
		// diagnosticsVersion counter) would have advanced because of A — B must
		// still reconcile as unresolved, never resolved-clean (#240).
		const touchedAt = Date.now() - 1000;
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/a.ts",
			serverId: "typescript",
			touchedAt,
		});
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/b.ts",
			serverId: "typescript",
			touchedAt,
		});

		// ONE shared client: only a.ts has a post-touch publish entry.
		const shared = warmClient("typescript", [
			["C:/repo/a.ts", [{ message: "err in a" }], touchedAt + 300],
		]);
		const lspService = {
			getWarmClientForFile: vi.fn().mockResolvedValue(shared),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes).toHaveLength(2);
		const byFile = Object.fromEntries(
			outcomes.map((o) => [o.filePath, o.outcome]),
		);
		expect(byFile["C:/repo/a.ts"]).toBe("resolved-found");
		expect(byFile["C:/repo/b.ts"]).toBe("unresolved");
	});

	it("records unresolved on a warm-miss (client idle-reaped) — reconcile must NEVER spawn a server", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: Date.now(),
		});

		const getWarmClientForFile = vi.fn().mockResolvedValue(undefined);
		const lspService = { getWarmClientForFile };
		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
		// The warm-only accessor is the ONLY lookup used — no get-or-create.
		expect(getWarmClientForFile).toHaveBeenCalledTimes(1);
	});

	it("records unresolved when a different server now owns the file", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: Date.now() - 1000,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(warmClient("deno", [[FILE, [], Date.now()]])),
		};
		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("records unresolved (never throws) when the client lookup itself rejects", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: Date.now(),
		});

		const lspService = {
			getWarmClientForFile: vi.fn().mockRejectedValue(new Error("boom")),
		};
		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("drains and resolves multiple outstanding touches independently", async () => {
		const touchedAt = Date.now() - 1000;
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/a.ts",
			serverId: "typescript",
			touchedAt,
		});
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/b.ts",
			serverId: "typescript",
			touchedAt,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockImplementation(async (filePath: string) => {
					if (filePath.endsWith("a.ts")) {
						return warmClient("typescript", [
							["C:/repo/a.ts", [], touchedAt + 200],
						]);
					}
					return undefined; // b.ts's client vanished
				}),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes).toHaveLength(2);
		const byFile = Object.fromEntries(
			outcomes.map((o) => [o.filePath, o.outcome]),
		);
		expect(byFile["C:/repo/a.ts"]).toBe("resolved-clean");
		expect(byFile["C:/repo/b.ts"]).toBe("unresolved");
	});
});

describe("registerCascadeTierReconcileTask", () => {
	let mod: typeof import("../../../clients/lsp/cascade-tier.js");

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		registerQuietWindowTask.mockReset();
		mod = await import("../../../clients/lsp/cascade-tier.js");
		mod._resetOutstandingCascadeTouchesForTests();
		mod._resetCascadeTierReconcileRegistrationForTests();
	});

	it("registers exactly one quiet-window task, idempotently", () => {
		mod.registerCascadeTierReconcileTask(() => ({}) as any);
		mod.registerCascadeTierReconcileTask(() => ({}) as any);
		expect(registerQuietWindowTask).toHaveBeenCalledTimes(1);
		expect(registerQuietWindowTask).toHaveBeenCalledWith(
			"cascade_tier3_reconcile",
			expect.any(Function),
		);
	});

	it("the registered task is a no-op when the registry is empty", async () => {
		mod.registerCascadeTierReconcileTask(() => ({
			getWarmClientForFile: vi.fn(),
		}) as any);
		const task = registerQuietWindowTask.mock.calls[0][1] as () => Promise<void>;
		await expect(task()).resolves.toBeUndefined();
	});
});

describe("isTierAwareCascadeEnabled kill switch", () => {
	let mod: typeof import("../../../clients/lsp/cascade-tier.js");
	const originalEnv = process.env.PI_LENS_TIER_AWARE_CASCADE;

	beforeEach(async () => {
		vi.resetModules();
		delete process.env.PI_LENS_TIER_AWARE_CASCADE;
		mod = await import("../../../clients/lsp/cascade-tier.js");
		mod._resetTierAwareCascadeEnabledForTests();
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_TIER_AWARE_CASCADE;
		} else {
			process.env.PI_LENS_TIER_AWARE_CASCADE = originalEnv;
		}
	});

	it("defaults to enabled", () => {
		expect(mod.isTierAwareCascadeEnabled()).toBe(true);
	});

	it("PI_LENS_TIER_AWARE_CASCADE=0 disables it", () => {
		process.env.PI_LENS_TIER_AWARE_CASCADE = "0";
		mod._resetTierAwareCascadeEnabledForTests();
		expect(mod.isTierAwareCascadeEnabled()).toBe(false);
	});

	it("any other value keeps it enabled", () => {
		process.env.PI_LENS_TIER_AWARE_CASCADE = "false";
		mod._resetTierAwareCascadeEnabledForTests();
		expect(mod.isTierAwareCascadeEnabled()).toBe(true);
	});

	it("memoizes the read (module-level cache, like isQuietWindowEnabled)", () => {
		expect(mod.isTierAwareCascadeEnabled()).toBe(true);
		process.env.PI_LENS_TIER_AWARE_CASCADE = "0";
		// Still true — cached until _resetTierAwareCascadeEnabledForTests().
		expect(mod.isTierAwareCascadeEnabled()).toBe(true);
	});
});
