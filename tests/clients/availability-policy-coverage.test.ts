/**
 * Coverage gate for the shared availability policy (#1476).
 *
 * #1467 fixed four clients that each latched a timed-out probe as a permanent
 * "tool is not installed" verdict. Its class sweep still missed three more, and
 * the #1476 sweep found three beyond those — including `ctx.hasTool`, the
 * generic seam every CLI runner gates on. The next tool would have been the
 * eleventh. This test DERIVES the consumer list from the source tree and fails
 * when a consumer it can SEE decides availability with its own copy of the rule.
 *
 * It is not a proof that no such consumer exists, and it must not be cited as
 * one. A verification round invented twelve shapes it does not catch — accessor
 * pairs, WeakMap and symbol-keyed stores, cross-module probe helpers, spawn
 * behind a constructor-assigned indirection, string-union verdicts — and three
 * of those are already idiomatic in this repo. Five known unrouted sites are
 * invisible to it today: `createCwdCachedProbe` with its eslint, credo and
 * rust-clippy consumers (#1494), `formatters.ts` (#1495) and
 * `package-manager.ts` (#1496); the last two memoize a resolved PATH rather than
 * a boolean verdict, so the verdict-shape rule cannot reach them at all.
 *
 * The first version of this gate was regexes and a review broke it seven ways in
 * one sitting. Treating a gate as proof is how that happened; every widening
 * below is pinned by a fixture so the next narrowing is visible.
 *
 * ## Structural, and per unit
 *
 * The analysis lives in `tests/support/availability-gate.ts` and runs on the
 * real AST (`@ast-grep/napi`), not on file text. Two properties come from that
 * and both were bought with review findings:
 *
 *   * "routed through the policy" means an `import_statement` node binds a
 *     policy symbol. A `// route this through availability-policy.js` comment
 *     used to clear a file. It no longer parses as anything at all.
 *   * the unit of judgement is a top-level declaration, not a file. The
 *     file-level gate cleared `runner-helpers.ts` and `govulncheck-client.ts`
 *     because each already imported the policy for a DIFFERENT memo, hiding two
 *     of the seven sites this change migrates.
 *
 * A unit is a consumer when it spawns a version probe AND parks the verdict in
 * state that outlives the call. It must then reach the shared policy: directly,
 * via `createAvailabilityChecker`, or by extending `SecurityScanClient`.
 *
 * ## The known-gap baseline
 *
 * `KNOWN_GAPS` is a shrink-only list of latches that predate this gate and are
 * tracked separately. It is not the hand-maintained roster #883 warned about:
 * nothing is added to it silently — a NEW unrouted consumer fails the gate, and
 * a baseline entry that stops being flagged ALSO fails, so a fix cannot leave
 * dead scaffolding behind.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type AvailabilityUnit,
	analyzeAvailabilityUnits,
	scanClientsTree,
	unitId,
} from "../support/availability-gate.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/**
 * Hand-rolled latches that predate this gate. Each is a real instance of the
 * shape, filed for its own fix; none may grow without a review noticing.
 */
const KNOWN_GAPS: ReadonlyArray<{ id: string; why: string }> = [
	{
		id: "clients/pipeline.ts::tryEslintFix",
		why: "`_eslintCache` latches an eslint --version verdict per cwd+PATH. Filed as #1494. Note this baseline covers ONLY this unit — `createCwdCachedProbe`'s eslint/credo/rust-clippy consumers are unrouted too but the gate does not detect them, so their absence here is a blind spot, not a clean bill.",
	},
];

/** Every consumer the #1467/#1476 sweeps migrated; the scan must still see them. */
const KNOWN_CONSUMERS = [
	"clients/biome-client.ts::BiomeClient",
	"clients/dead-code-client.ts::PythonDeadCodeClient",
	"clients/dependency-checker.ts::DependencyChecker",
	"clients/dispatch/dispatcher.ts::checkToolAvailability",
	"clients/dispatch/runners/utils/runner-helpers.ts::createAvailabilityChecker",
	// The second latch in the same file — invisible to a per-file gate.
	"clients/dispatch/runners/utils/runner-helpers.ts::isSgAvailableAsync",
	"clients/go-client.ts::GoClient",
	"clients/govulncheck-client.ts::GovulncheckClient",
	"clients/jscpd-client.ts::jscpdAvailability",
	"clients/knip-client.ts::KnipClient",
	"clients/rust-client.ts::RustClient",
	"clients/sg-runner.ts::SgRunner",
];

/**
 * The seven ways a reviewer broke the regex version of this gate, each written
 * as it would appear in `clients/`. Every one must read as an unrouted
 * consumer. They are the gate's own regression suite: widening the vocabulary
 * without a fixture is how the gate silently narrows again.
 */
const EVASIONS: ReadonlyArray<{ name: string; source: string }> = [
	{
		// A verification round found this one escaping, and the cause was a bug
		// rather than a scoping choice: memo writes resolve against the DECLARED
		// name, and the analyser took the last dot segment, so `registry.toolAvailable`
		// looked up a declaration called `toolAvailable` and found nothing. The
		// same slip let a nested `cached.entries.set(...)` through.
		name: "a verdict parked on a module-level registry object",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			const registry: { toolAvailable: boolean | null } = { toolAvailable: null };
			export async function hasTool(): Promise<boolean> {
				if (registry.toolAvailable !== null) return registry.toolAvailable;
				const probe = await safeSpawnAsync("newtool", ["--version"], {});
				registry.toolAvailable = probe.status === 0;
				return registry.toolAvailable;
			}
		`,
	},
	{
		name: "a Map<string, boolean> cwd cache instead of an `avail`-named field",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			const cacheByCwd = new Map<string, boolean>();
			export async function hasTool(cwd: string): Promise<boolean> {
				const hit = cacheByCwd.get(cwd);
				if (hit !== undefined) return hit;
				const probe = await safeSpawnAsync("newtool", ["--version"], { cwd });
				cacheByCwd.set(cwd, probe.status === 0);
				return probe.status === 0;
			}
		`,
	},
	{
		name: "a field named `installed`",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export class NewToolClient {
				private installed: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.installed !== null) return this.installed;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					this.installed = probe.status === 0;
					return this.installed;
				}
			}
		`,
	},
	{
		name: "a closure factory holding `let cached`",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export function createNewToolProbe(): () => Promise<boolean> {
				let cached: boolean | null = null;
				return async () => {
					if (cached !== null) return cached;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					cached = probe.status === 0;
					return cached;
				};
			}
		`,
	},
	{
		name: "a probe flag hoisted into a const rather than written as a literal",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			const VERSION_ARGS = ["--version"];
			export class NewToolClient {
				private toolAvailable: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.toolAvailable !== null) return this.toolAvailable;
					const probe = await safeSpawnAsync("newtool", VERSION_ARGS, {});
					this.toolAvailable = probe.status === 0;
					return this.toolAvailable;
				}
			}
		`,
	},
	{
		name: "a probe that asks with `-v`",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export class NewToolClient {
				private toolAvailable: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.toolAvailable !== null) return this.toolAvailable;
					const probe = await safeSpawnAsync("newtool", ["-v"], {});
					this.toolAvailable = probe.status === 0;
					return this.toolAvailable;
				}
			}
		`,
	},
	{
		name: "an optional boolean field with no initialiser",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export class NewToolClient {
				private fooAvailable?: boolean;
				async ensureAvailable(): Promise<boolean> {
					if (this.fooAvailable !== undefined) return this.fooAvailable;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					this.fooAvailable = probe.status === 0;
					return this.fooAvailable;
				}
			}
		`,
	},
	{
		// Pins the #1476 follow-up widening: `createToolchainAvailability` counts
		// as routed ONLY when it is the shared helper. A same-named factory from
		// anywhere else is a private copy of the rule, which is the defect.
		name: "a lookalike availability factory imported from outside the policy",
		source: `
			import { createToolchainAvailability } from "./tool-checks.js";
			export class NewToolClient {
				private readonly availability = createToolchainAvailability({
					tool: "newtool",
					probeArgs: ["--version"],
				});
				async ensureAvailable(): Promise<boolean> {
					return this.availability.isAvailable();
				}
			}
		`,
	},
	{
		name: "the defect shape plus a comment that names availability-policy.js",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			// TODO: route this through availability-policy.js
			export class NewToolClient {
				private toolAvailable: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.toolAvailable !== null) return this.toolAvailable;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					this.toolAvailable = probe.status === 0;
					return this.toolAvailable;
				}
			}
		`,
	},
];

/** The positive control: the same client, migrated. It must pass. */
const COMPLIANT = `
	import { safeSpawnAsync } from "./safe-spawn.js";
	import {
		classifyProbeFailure,
		createAvailabilityLatch,
	} from "./dispatch/runners/utils/availability-policy.js";
	export class NewToolClient {
		private readonly availabilityLatch = createAvailabilityLatch();
		async ensureAvailable(): Promise<boolean> {
			const memo = this.availabilityLatch.read();
			if (memo !== null) return memo;
			const probe = await safeSpawnAsync("newtool", ["--version"], {});
			if (probe.status === 0) {
				this.availabilityLatch.noteAvailable();
				return true;
			}
			const { outcome, cause } = classifyProbeFailure(probe);
			this.availabilityLatch.noteUnavailable(outcome, cause);
			return false;
		}
	}
`;

describe("availability policy coverage (#1476)", () => {
	let consumers: AvailabilityUnit[];

	beforeAll(async () => {
		consumers = await scanClientsTree(repoRoot);
	});

	it("every availability consumer routes through the shared policy", () => {
		const baseline = new Set(KNOWN_GAPS.map((gap) => gap.id));
		const unrouted = consumers
			.filter((unit) => !unit.governed)
			.map(unitId)
			.filter((id) => !baseline.has(id));
		expect(
			unrouted,
			[
				"These units decide tool availability with their own copy of the rule.",
				"Route them through clients/dispatch/runners/utils/availability-policy.ts",
				"(directly, via createAvailabilityChecker, or via SecurityScanClient) so a",
				"timed-out probe cannot latch as 'the tool is not installed' (#1467/#1476).",
			].join(" "),
		).toEqual([]);
	});

	it("the known-gap baseline is still accurate", () => {
		// A baseline entry that stopped being flagged is scaffolding around a fix
		// that already landed; deleting it is part of the fix.
		const flagged = new Set(
			consumers.filter((unit) => !unit.governed).map(unitId),
		);
		const stale = KNOWN_GAPS.map((gap) => gap.id).filter(
			(id) => !flagged.has(id),
		);
		expect(
			stale,
			"These KNOWN_GAPS entries are no longer flagged — delete them.",
		).toEqual([]);
	});

	it("the derived set actually covers the known consumers", () => {
		// Guards the scan itself: an analysis that stopped matching would make the
		// assertion above pass over an empty set — defect shape 7, a vacuous test.
		const ids = consumers.map(unitId);
		for (const known of KNOWN_CONSUMERS) {
			expect(ids).toContain(known);
		}
	});

	describe("the gate catches every shape the review evaded it with", () => {
		for (const evasion of EVASIONS) {
			it(evasion.name, async () => {
				const units = await analyzeAvailabilityUnits(
					evasion.source,
					"clients/new-tool-client.ts",
				);
				expect(
					units.map((unit) => unit.unit),
					"the analysis did not recognise this as an availability consumer",
				).not.toEqual([]);
				expect(
					units.filter((unit) => unit.governed),
					"an unrouted latch was reported as routed through the policy",
				).toEqual([]);
			});
		}
	});

	it("flags a second hand-rolled latch beside a compliant one", async () => {
		// The per-FILE gate cleared this shape, and that is how two of the seven
		// sites this change migrates stayed invisible: the file already imported
		// the policy, for a different memo.
		const units = await analyzeAvailabilityUnits(
			`
				import { safeSpawnAsync } from "./safe-spawn.js";
				import { createAvailabilityLatch } from "./dispatch/runners/utils/availability-policy.js";
				export class MigratedClient {
					private readonly availabilityLatch = createAvailabilityLatch();
					async ensureAvailable(): Promise<boolean> {
						const memo = this.availabilityLatch.read();
						if (memo !== null) return memo;
						const probe = await safeSpawnAsync("newtool", ["--version"], {});
						if (probe.status === 0) {
							this.availabilityLatch.noteAvailable();
							return true;
						}
						this.availabilityLatch.noteUnavailable("missing", "not-found");
						return false;
					}
				}
				let secondToolAvailable: boolean | null = null;
				export async function isSecondToolAvailable(): Promise<boolean> {
					if (secondToolAvailable !== null) return secondToolAvailable;
					const probe = await safeSpawnAsync("secondtool", ["--version"], {});
					secondToolAvailable = probe.status === 0;
					return secondToolAvailable;
				}
			`,
			"clients/two-latches.ts",
		);
		expect(units.filter((unit) => !unit.governed).map((unit) => unit.unit)).toEqual(
			["isSecondToolAvailable"],
		);
		expect(units.filter((unit) => unit.governed).map((unit) => unit.unit)).toEqual(
			["MigratedClient"],
		);
	});

	it("follows a probe that lives one helper away from the latch", async () => {
		// `runner-helpers.ts` pre-#1476: the `--version` literal and the spawn sat
		// in `probeAstGrepCommandAsync` while the latch sat in `isSgAvailableAsync`.
		const units = await analyzeAvailabilityUnits(
			`
				import { safeSpawnAsync } from "./safe-spawn.js";
				let toolAvailable: boolean | null = null;
				async function probeTool(cmd: string): Promise<boolean> {
					const check = await safeSpawnAsync(cmd, ["--version"], { timeout: 5000 });
					return !check.error && check.status === 0;
				}
				export async function isToolAvailableAsync(): Promise<boolean> {
					if (toolAvailable !== null) return toolAvailable;
					toolAvailable = await probeTool("newtool");
					return toolAvailable;
				}
			`,
			"clients/helper-split.ts",
		);
		expect(units.map((unit) => unit.unit)).toContain("isToolAvailableAsync");
		expect(units.filter((unit) => unit.governed)).toEqual([]);
	});

	it("a migrated client passes the gate", async () => {
		const units = await analyzeAvailabilityUnits(
			COMPLIANT,
			"clients/new-tool-client.ts",
		);
		expect(units.map((unit) => unit.unit)).toEqual(["NewToolClient"]);
		expect(units[0]?.governed).toBe(true);
	});

	it("a client that delegates its lifecycle to the shared helper is routed", async () => {
		// The #1476 follow-up moved the latch, the in-flight dedupe and the
		// decision records out of `go-client.ts` and `rust-client.ts` and into
		// `toolchain-availability.ts`. The clients must stay VISIBLE as consumers
		// — a refactor that made them vanish from the scan would read as green
		// while removing them from the gate's coverage.
		const units = await analyzeAvailabilityUnits(
			`
				import { createToolchainAvailability } from "./dispatch/runners/utils/toolchain-availability.js";
				export class NewToolClient {
					private readonly availability = createToolchainAvailability({
						tool: "newtool",
						probeArgs: ["--version"],
					});
					async ensureAvailable(): Promise<boolean> {
						return this.availability.isAvailable();
					}
				}
			`,
			"clients/new-tool-client.ts",
		);
		expect(units.map((unit) => unit.unit)).toEqual(["NewToolClient"]);
		expect(units[0]?.governed).toBe(true);
	});

	it("a client with no probe is not a consumer at all", async () => {
		// The scan must not drag in every module that happens to own a cache.
		const units = await analyzeAvailabilityUnits(
			`
				const cacheByCwd = new Map<string, boolean>();
				export function rememberTrust(cwd: string, trusted: boolean): void {
					cacheByCwd.set(cwd, trusted);
				}
			`,
			"clients/trust-cache.ts",
		);
		expect(units).toEqual([]);
	});
});
