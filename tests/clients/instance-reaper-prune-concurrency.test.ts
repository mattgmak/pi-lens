/**
 * #1217 regression: `pruneDeadInstances` (clients/instance-reaper.ts) staged
 * the machine-global `instances.json` at a hand-rolled
 * `${target}.tmp-${process.pid}` instead of going through `atomic-write.ts`,
 * so it never inherited the #1205 per-call staging fix.
 *
 * Two concurrent prunes in one process computed the identical staging path,
 * both wrote into it, and the first rename published that inode while the
 * second was still writing — publishing a torn `instances.json`. This store
 * degrades a parse failure to empty (`readInstanceRegistry`), so a tear drops
 * EVERY registered instance rather than the one entry being pruned.
 *
 * Concurrency here is by design, not exceptional: `instance-registry.ts`'s
 * `getResourceFootprint` fires `prunePids(...)` fire-and-forget while the
 * reaper runs its own sweep, with nothing serializing the two.
 *
 * Payload sizes are mismatched (many instances vs few) so a hybrid is
 * detectable, and the file is asserted to parse AND to be one of the two
 * intended states — a truncated JSON object that happens to still parse would
 * otherwise pass. Nothing branches on `process.platform`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneDeadInstances } from "../../clients/instance-reaper.js";
import type { InstanceEntry } from "../../clients/instance-registry.js";
import { removeTempDirSync } from "./test-utils.js";

let home: string;
let registryPath: string;
const savedHome = process.env.PI_LENS_HOME;

function entry(pid: number, pad = 0): InstanceEntry {
	return {
		pid,
		startedAt: "2026-01-01T00:00:00.000Z",
		projectRoot: `/proj/${pid}${"x".repeat(pad)}`,
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: "2026-01-01T00:00:00.000Z",
	};
}

/** `count` instances with pids 1..count, each `pad` bytes wider. */
function seedRegistry(count: number, pad = 0): void {
	const instances = Array.from({ length: count }, (_, i) => entry(i + 1, pad));
	fs.writeFileSync(registryPath, JSON.stringify({ instances }), "utf-8");
}

function readPids(): number[] {
	const parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
	return (parsed.instances as InstanceEntry[]).map((i) => i.pid);
}

function stageLeftovers(): string[] {
	return fs.readdirSync(home).filter((name) => name.includes(".tmp-"));
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-prune-"));
	process.env.PI_LENS_HOME = home;
	registryPath = path.join(home, "instances.json");
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = savedHome;
	removeTempDirSync(home);
});

describe("pruneDeadInstances", () => {
	it("drops exactly the named pids", async () => {
		seedRegistry(5);
		await pruneDeadInstances(new Set([2, 4]));
		expect(readPids()).toEqual([1, 3, 5]);
	});

	it("leaves the file untouched when no pid matches", async () => {
		seedRegistry(3);
		const before = fs.readFileSync(registryPath, "utf-8");
		await pruneDeadInstances(new Set([99]));
		expect(fs.readFileSync(registryPath, "utf-8")).toBe(before);
	});

	it("leaves no staging file behind", async () => {
		seedRegistry(3);
		await pruneDeadInstances(new Set([1]));
		expect(stageLeftovers()).toEqual([]);
	});

	it("is best-effort on a missing registry", async () => {
		await expect(pruneDeadInstances(new Set([1]))).resolves.toBeUndefined();
	});
});

describe("concurrent pruneDeadInstances on one registry (#1217)", () => {
	const ITERATIONS = 40;
	// BOTH results have to be large, and differ in size: the tear comes from two
	// writers overlapping INSIDE the shared inode (the second `open(O_TRUNC)`s
	// while the first is mid-write, and each fd carries its own offset), not
	// from the rename alone. Pairing a big result with a tiny one does not
	// reproduce it — the tiny writer is long finished before the big one starts,
	// and the big writer then simply overwrites the whole file with its own
	// complete content. Each writer also reads and parses the same ~2 MB file
	// first, which desynchronizes them further, so the payloads must be big
	// enough that the writes still overlap after that. ~2 MB vs ~1 MB here;
	// #1205 measured its Linux reproduction at 21/40 on the same scale.
	const TOTAL = 1200;
	const PAD = 1600;
	const EVENS = Array.from({ length: TOTAL / 2 }, (_, n) => (n + 1) * 2);

	it("always publishes a parseable registry that is one of the two results", async () => {
		const outcomes: string[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			seedRegistry(TOTAL, PAD);
			// One prune drops a single pid (~2 MB result); the other drops every
			// even pid (~1 MB result).
			const pruneOne = new Set([2]);
			const pruneEvens = new Set(EVENS);
			// Alternate launch order so neither writer is systematically first.
			const [first, second] =
				i % 2 === 0 ? [pruneOne, pruneEvens] : [pruneEvens, pruneOne];
			await Promise.all([
				pruneDeadInstances(first),
				pruneDeadInstances(second),
			]);

			const raw = fs.readFileSync(registryPath, "utf-8");
			let pids: number[];
			try {
				pids = (JSON.parse(raw).instances as InstanceEntry[]).map((e) => e.pid);
			} catch {
				outcomes.push(`UNPARSABLE(len=${raw.length})`);
				continue;
			}
			// Either writer may win — but the winner's whole result must be
			// published, never one spliced into the other.
			if (pids.length === TOTAL - 1 && !pids.includes(2))
				outcomes.push("ONE_PRUNED");
			else if (pids.length === TOTAL / 2 && pids.every((p) => p % 2 === 1))
				outcomes.push("EVENS_PRUNED");
			else outcomes.push(`HYBRID(entries=${pids.length}, len=${raw.length})`);
		}
		expect(
			outcomes.filter((o) => o.startsWith("HYBRID") || o.startsWith("UNPARS")),
		).toEqual([]);
	});

	it("leaves no staging files behind after concurrent prunes", async () => {
		seedRegistry(TOTAL, PAD);
		await Promise.all(
			Array.from({ length: 8 }, (_, i) => pruneDeadInstances(new Set([i + 2]))),
		);
		expect(stageLeftovers()).toEqual([]);
	});
});
