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

	it("resolves an outstanding touch as resolved-found when diagnostics arrived since the baseline", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			baselineVersion: 5,
			touchedAt: Date.now() - 1000,
		});

		const lspService = {
			getClientForFile: vi.fn().mockResolvedValue({
				client: {
					serverId: "typescript",
					diagnosticsVersion: 6,
					getDiagnostics: vi.fn().mockReturnValue([{ message: "err" }]),
				},
			}),
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

	it("resolves an outstanding touch as resolved-clean when the version advanced but diagnostics are empty", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			baselineVersion: 5,
			touchedAt: Date.now() - 1000,
		});

		const lspService = {
			getClientForFile: vi.fn().mockResolvedValue({
				client: {
					serverId: "typescript",
					diagnosticsVersion: 7,
					getDiagnostics: vi.fn().mockReturnValue([]),
				},
			}),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0]).toMatchObject({
			outcome: "resolved-clean",
			diagnosticCount: 0,
		});
	});

	it("records unresolved — NEVER clean — when nothing published by settle time (#240 doctrine)", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			baselineVersion: 5,
			touchedAt: Date.now() - 1000,
		});

		const lspService = {
			getClientForFile: vi.fn().mockResolvedValue({
				client: {
					serverId: "typescript",
					diagnosticsVersion: 5, // unchanged — nothing published
					getDiagnostics: vi.fn().mockReturnValue([]),
				},
			}),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("records unresolved when the client is gone or a different server now owns the file", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			baselineVersion: 5,
			touchedAt: Date.now(),
		});

		const lspService = { getClientForFile: vi.fn().mockResolvedValue(undefined) };
		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("records unresolved (never throws) when the client lookup itself rejects", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			baselineVersion: 5,
			touchedAt: Date.now(),
		});

		const lspService = {
			getClientForFile: vi.fn().mockRejectedValue(new Error("boom")),
		};
		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("drains and resolves multiple outstanding touches independently", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/a.ts",
			serverId: "typescript",
			baselineVersion: 1,
			touchedAt: Date.now(),
		});
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/b.ts",
			serverId: "typescript",
			baselineVersion: 1,
			touchedAt: Date.now(),
		});

		const lspService = {
			getClientForFile: vi.fn().mockImplementation(async (filePath: string) => {
				if (filePath.endsWith("a.ts")) {
					return {
						client: {
							serverId: "typescript",
							diagnosticsVersion: 2,
							getDiagnostics: vi.fn().mockReturnValue([]),
						},
					};
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
			getClientForFile: vi.fn(),
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
