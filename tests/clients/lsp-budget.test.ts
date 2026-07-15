/**
 * Tests for the PURE decision logic in clients/lsp-budget.ts
 * (`decideLspBudget`) — #449 slice 2 prototype. All liveness checks are
 * injected fake predicates; no real process.kill/spawn/fs ever runs here.
 * Mirrors the test shape of tests/clients/instance-reaper.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	decideLspBudget,
	DEFAULT_LSP_BUDGET_CEILING,
	getLspBudgetCeiling,
	isCrossProcessBudgetEnabled,
	_resetLspBudgetDecisionForTests,
	shouldDegradeAuxiliaryLsp,
} from "../../clients/lsp-budget.js";
import type { InstanceEntry, LspChildEntry } from "../../clients/instance-registry.js";

function lspChild(overrides: Partial<LspChildEntry> = {}): LspChildEntry {
	return {
		pid: 1000,
		serverId: "typescript",
		command: "typescript-language-server",
		spawnedAt: new Date().toISOString(),
		...overrides,
	};
}

function instance(overrides: Partial<InstanceEntry> = {}): InstanceEntry {
	return {
		pid: 1,
		startedAt: new Date().toISOString(),
		projectRoot: "/proj",
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: new Date().toISOString(),
		...overrides,
	};
}

function alivePids(...pids: number[]): (pid: number) => boolean {
	const set = new Set(pids);
	return (pid) => set.has(pid);
}

function childrenOfCount(n: number, serverId: string, startPid: number): LspChildEntry[] {
	return Array.from({ length: n }, (_, i) =>
		lspChild({ pid: startPid + i, serverId }),
	);
}

describe("decideLspBudget", () => {
	it("under ceiling — not over budget, aux not degraded", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(3, "typescript", 100) }),
			instance({ pid: 2, lspChildren: childrenOfCount(2, "pyright", 200) }),
		];
		const decision = decideLspBudget(reg, alivePids(1, 2, 100, 101, 102, 200, 201), 16);

		expect(decision.totalLiveLspServers).toBe(5);
		expect(decision.overBudget).toBe(false);
		expect(decision.degradeAuxiliary).toBe(false);
	});

	it("at/over ceiling — over budget, aux degraded", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(10, "typescript", 100) }),
			instance({ pid: 2, lspChildren: childrenOfCount(10, "pyright", 200) }),
		];
		const decision = decideLspBudget(reg, () => true, 16);

		expect(decision.totalLiveLspServers).toBe(20);
		expect(decision.overBudget).toBe(true);
		expect(decision.degradeAuxiliary).toBe(true);
		expect(decision.ceiling).toBe(16);
	});

	it("exactly at ceiling counts as over budget (>=, not >)", () => {
		const reg = [instance({ pid: 1, lspChildren: childrenOfCount(16, "typescript", 100) })];
		const decision = decideLspBudget(reg, () => true, 16);

		expect(decision.totalLiveLspServers).toBe(16);
		expect(decision.overBudget).toBe(true);
	});

	it("dead-parent instances are excluded from the live count — orphan reaper's job, not double-counted here", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(20, "typescript", 100) }), // dead parent
			instance({ pid: 2, lspChildren: childrenOfCount(2, "pyright", 300) }), // alive parent
		];
		// Only pid 2 is alive; pid 1's children don't count toward the total.
		const decision = decideLspBudget(reg, alivePids(2), 16);

		expect(decision.totalLiveLspServers).toBe(2);
		expect(decision.overBudget).toBe(false);
	});

	it("empty registry — zero load, never over budget", () => {
		const decision = decideLspBudget([], () => true, 16);
		expect(decision.totalLiveLspServers).toBe(0);
		expect(decision.overBudget).toBe(false);
		expect(decision.degradeAuxiliary).toBe(false);
	});
});

describe("getLspBudgetCeiling / isCrossProcessBudgetEnabled (env config)", () => {
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	it("defaults to DEFAULT_LSP_BUDGET_CEILING when unset", () => {
		delete process.env.PI_LENS_LSP_BUDGET_CEILING;
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
	});

	it("honors a valid positive override", () => {
		process.env.PI_LENS_LSP_BUDGET_CEILING = "8";
		expect(getLspBudgetCeiling()).toBe(8);
	});

	it("falls back to default on a non-finite/zero/negative override (NaN guard)", () => {
		process.env.PI_LENS_LSP_BUDGET_CEILING = "not-a-number";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
		process.env.PI_LENS_LSP_BUDGET_CEILING = "0";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
		process.env.PI_LENS_LSP_BUDGET_CEILING = "-5";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
	});

	it("enabled by default; PI_LENS_CROSS_PROCESS_BUDGET=0 disables", () => {
		delete process.env.PI_LENS_CROSS_PROCESS_BUDGET;
		expect(isCrossProcessBudgetEnabled()).toBe(true);
		process.env.PI_LENS_CROSS_PROCESS_BUDGET = "0";
		expect(isCrossProcessBudgetEnabled()).toBe(false);
	});
});

describe("shouldDegradeAuxiliaryLsp (module-scope decision cache)", () => {
	beforeEach(() => {
		_resetLspBudgetDecisionForTests();
	});

	it("defaults to false before any check has run — fail toward today's behavior", () => {
		expect(shouldDegradeAuxiliaryLsp()).toBe(false);
	});
});
