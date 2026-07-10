/**
 * Tests for the PURE decision logic in clients/instance-reaper.ts
 * (`decideOrphanReaping`) — #472. All liveness/identity checks are injected
 * fake predicates; no real process.kill/spawn ever runs in these tests.
 */

import { describe, expect, it } from "vitest";
import {
	decideOrphanReaping,
	type ChildToKill,
} from "../../clients/instance-reaper.js";
import type { InstanceEntry, LspChildEntry } from "../../clients/instance-registry.js";

function child(overrides: Partial<LspChildEntry> = {}): LspChildEntry {
	return {
		pid: 1000,
		serverId: "ast-grep",
		command: "ast-grep.exe",
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

describe("decideOrphanReaping", () => {
	it("live parent pid — instance and all its children are left untouched", () => {
		const reg = [
			instance({ pid: 1, lspChildren: [child({ pid: 100 })] }),
		];
		const decision = decideOrphanReaping(reg, alivePids(1, 100));

		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("dead parent pid + live child pid — child goes in the kill list", () => {
		const reg = [
			instance({ pid: 1, lspChildren: [child({ pid: 100, serverId: "ast-grep" })] }),
		];
		const decision = decideOrphanReaping(reg, alivePids(100)); // 1 is dead

		expect(decision.deadInstances).toHaveLength(1);
		expect(decision.deadInstances[0].pid).toBe(1);
		expect(decision.childrenToKill).toEqual<ChildToKill[]>([
			{ pid: 100, serverId: "ast-grep", command: "ast-grep.exe" },
		]);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("dead parent pid + already-dead child pid, no marker — nothing to kill or search", () => {
		const reg = [instance({ pid: 1, lspChildren: [child({ pid: 100 })] })];
		const decision = decideOrphanReaping(reg, alivePids()); // nothing alive

		expect(decision.deadInstances).toHaveLength(1);
		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("dead parent pid + dead child pid WITH a marker — surfaces a marker search, not a direct kill", () => {
		const reg = [
			instance({
				pid: 1,
				lspChildren: [
					child({ pid: 100, marker: "C:/temp/pi-lens-ast-grep/x.yml" }),
				],
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids());

		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toEqual([
			{ marker: "C:/temp/pi-lens-ast-grep/x.yml", serverId: "ast-grep" },
		]);
	});

	it("ESRCH-vs-EPERM conservatism: an ambiguous/ EPERM-style liveness result must NOT be treated as dead", () => {
		// Simulate: isPidAlive returns true for pid 1 (EPERM path — exists, no
		// permission, or any non-ESRCH outcome must be conservative "alive").
		const reg = [instance({ pid: 1, lspChildren: [child({ pid: 100 })] })];
		const decision = decideOrphanReaping(reg, alivePids(1, 100));

		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.childrenToKill).toHaveLength(0);
	});

	it("multiple dead instances each contribute their own children to the kill list", () => {
		const reg = [
			instance({ pid: 1, lspChildren: [child({ pid: 100, serverId: "ast-grep" })] }),
			instance({ pid: 2, lspChildren: [child({ pid: 200, serverId: "typescript" })] }),
		];
		const decision = decideOrphanReaping(reg, alivePids(100, 200)); // both parents dead

		expect(decision.deadInstances).toHaveLength(2);
		expect(decision.childrenToKill).toHaveLength(2);
		expect(decision.childrenToKill.map((c) => c.serverId).sort()).toEqual([
			"ast-grep",
			"typescript",
		]);
	});

	it("a live child under a matchProcess identity mismatch (recycled pid) is NOT killed directly, falls to marker search", () => {
		const reg = [
			instance({
				pid: 1,
				lspChildren: [
					child({
						pid: 100,
						command: "ast-grep.exe",
						marker: "C:/temp/pi-lens-ast-grep/y.yml",
					}),
				],
			}),
		];
		const matchProcess = () => false; // pid recycled to an unrelated process
		const decision = decideOrphanReaping(reg, alivePids(100), matchProcess);

		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toEqual([
			{ marker: "C:/temp/pi-lens-ast-grep/y.yml", serverId: "ast-grep" },
		]);
	});

	it("a live child WITH matching identity is killed even when matchProcess is provided", () => {
		const reg = [
			instance({
				pid: 1,
				lspChildren: [child({ pid: 100, command: "ast-grep.exe" })],
			}),
		];
		const matchProcess = (_pid: number, expected: { command: string }) =>
			expected.command === "ast-grep.exe";
		const decision = decideOrphanReaping(reg, alivePids(100), matchProcess);

		expect(decision.childrenToKill).toHaveLength(1);
	});

	it("empty registry — no work at all", () => {
		const decision = decideOrphanReaping([], alivePids());
		expect(decision.deadInstances).toHaveLength(0);
		expect(decision.childrenToKill).toHaveLength(0);
		expect(decision.markerSearches).toHaveLength(0);
	});

	it("dead parent with multiple children — mixed live/dead/marker outcomes coexist", () => {
		const reg = [
			instance({
				pid: 1,
				lspChildren: [
					child({ pid: 100, serverId: "a", command: "a.exe" }), // will be alive
					child({ pid: 200, serverId: "b", command: "b.exe" }), // dead, no marker
					child({
						pid: 300,
						serverId: "c",
						command: "c.exe",
						marker: "C:/temp/pi-lens-ast-grep/m.yml",
					}), // dead, with marker
				],
			}),
		];
		const decision = decideOrphanReaping(reg, alivePids(100));

		expect(decision.childrenToKill).toEqual([
			{ pid: 100, serverId: "a", command: "a.exe" },
		]);
		expect(decision.markerSearches).toEqual([
			{ marker: "C:/temp/pi-lens-ast-grep/m.yml", serverId: "c" },
		]);
	});
});
