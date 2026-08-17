/**
 * R8 (#714) — per-result early-unblock: slow auxiliary grace tests.
 *
 * Verifies that:
 *  1. Fast primary + slow aux: touchFile completes at ~primary+auxGrace, not at
 *     the aux deadline.
 *  2. Aux answering within grace: its diagnostics are included in the result.
 *  3. Slow primary: full wait as today (aux settling early does not shortcut
 *     primary confirmation).
 *  4. Primary-only path: zero new code path entered (grace timer never fires).
 *  5. getDiagnostics: fast primary + slow aux completes before aux deadline.
 *
 * Also covers the raceToCompletion aux-grace unit-level behaviour via the
 * aggregation.test.ts file; these tests exercise the service-level wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const FILE = "C:/repo/main.ts";
const AUX_GRACE_MS = 500; // Default PI_LENS_AUX_GRACE_MS

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 999,
	};
}

/** A language-primary server (no role, defaults to "language"). */
function makePrimaryServer(id: string, ext = ".ts") {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

/** An auxiliary server (role:"auxiliary"). */
function makeAuxServer(id: string, ext = ".ts") {
	return {
		id,
		name: id,
		extensions: [ext],
		role: "auxiliary" as const,
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		},
	};
}

/**
 * A fake LSP client whose waitForDiagnostics resolves after `delayMs` ms and
 * whose getDiagnostics returns `diags` only AFTER the wait has resolved
 * (simulating real LSP push behaviour: diagnostics land in the client's cache
 * when the server publishes them, which is what waitForDiagnostics waits for).
 */
function makeClient(
	delayMs: number,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
	options: { serverId?: string } = {},
) {
	let waitSettled = false;
	let version = 0;
	return {
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		// #1458 S6: production always sets `serverId` on the real client
		// (`createLSPClient({ serverId: server.id, ... })` in index.ts) and the
		// per-server budget lookup (`perServerTimeout`) matches entries by
		// `entry.client.serverId`. A double that omits it silently falls
		// through that match to a different branch, so a budgetMs assertion
		// can pass without exercising the real lookup at all. Always pass
		// `options.serverId` matching the server descriptor's id.
		serverId: options.serverId,
		// #1458 S1: a real publish advances `diagnosticsVersion` (client.ts
		// `recordBinding`/push handling). This is a GETTER (not a static
		// field) so the evidence-based aux-outcome check can observe the
		// bump. Spreading this object (`{...makeClient(...)}`) evaluates the
		// getter once and freezes its value — callers that need a live
		// version must construct via `options.serverId` instead of spreading.
		get diagnosticsVersion() {
			return version;
		},
		// Only returns diagnostics after waitForDiagnostics has resolved,
		// matching real client behaviour (server pushes → client caches → wait resolves).
		getDiagnostics: vi.fn(() => (waitSettled ? diags : [])),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						waitSettled = true;
						// A genuine publish (non-empty diags) is what advances the
						// version on a real client; a silent/empty settle must not,
						// or the evidence-based outcome check below can't tell the
						// two apart.
						if (diags.length > 0) version += 1;
						resolve();
					}, delayMs),
				),
		),
	};
}

function makeLateBoundClient(content: string, serverId = "opengrep") {
	let published = false;
	const diagnostic = makeDiagnostic("late aux finding");
	return {
		...makeClient(2500, [], { serverId }),
		getDiagnostics: vi.fn(() => (published ? [diagnostic] : [])),
		getDiagnosticBinding: vi.fn(() =>
			published ? { contentHash: hashDiagnosticContent(content) } : undefined,
		),
		notify: {
			open: vi.fn(async () => {
				published = false;
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						published = true;
						resolve();
					}, 2500),
				),
		),
	};
}

/**
 * #1458 S7: a version-less publish (server never reports `publishDiagnostics.
 * version`) makes `client.ts`'s `recordBinding` DELETE any stored binding
 * (`docVersion === undefined` branch) — never resurrect a stale one, never
 * synthesize a contentHash. `getDiagnosticBinding` must therefore keep
 * returning `undefined` even after diagnostics genuinely landed, so the
 * carry-over check (`binding?.contentHash !== touchContentHash`) fails
 * closed instead of replaying an unverifiable late result.
 */
function makeVersionlessLateClient(serverId = "opengrep") {
	let published = false;
	const diagnostic = makeDiagnostic("late aux finding");
	return {
		...makeClient(2500, [], { serverId }),
		getDiagnostics: vi.fn(() => (published ? [diagnostic] : [])),
		getDiagnosticBinding: vi.fn(() => undefined),
		notify: {
			open: vi.fn(async () => {
				published = false;
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						published = true;
						resolve();
					}, 2500),
				),
		),
	};
}

describe("R8 — aux grace: touchFile with-auxiliary path", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	it("completes at primary+auxGrace, not at the aux deadline", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Primary settles quickly; aux takes 3000ms (well beyond grace).
		const primaryClient = makeClient(100, [makeDiagnostic("primary error")], {
			serverId: "ts-primary",
		});
		const auxClient = makeClient(3000, [makeDiagnostic("aux finding")], {
			serverId: "opengrep-aux",
		});

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		// getServersForFileWithConfig drives candidate lookup; both servers
		// must appear so the service considers spawning them.
		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);

		// Primary comes first (getClientForFile), aux second (getAuxiliaryClientsForFile).
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		// Warm both into the cache.
		await service.getClientsForFile(FILE);
		// Re-mock for auxiliary lookup (getAuxiliaryClientsForFile uses a separate call).
		createLSPClient.mockReset();

		// For this touch the service resolves primary via getClientForFile and
		// auxiliary via getAuxiliaryClientsForFile. Since clients are already cached
		// (ensureClientForServer returns from state), no further createLSPClient calls
		// are needed — but we need both clients in the cache first.
		// Simplest approach: warm both clients again via a second getClientsForFile
		// (they deduplicate inside the service state).
		const touchPromise = service.touchFile(FILE, "content", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// Advance to primary settling (100ms).
		await vi.advanceTimersByTimeAsync(100);
		// Advance through aux grace window (500ms). Aux is still at 3000ms.
		await vi.advanceTimersByTimeAsync(AUX_GRACE_MS + 10);

		const result = await touchPromise;
		// Touch resolved before aux deadline (3000ms) — we only waited ~610ms.
		// Primary diagnostics included.
		expect(Array.isArray(result?.diags)).toBe(true);
		// Aux was cut off — its diagnostics may or may not be present depending
		// on whether it resolved before the grace expired. Since aux takes 3000ms
		// and grace is 500ms, aux is NOT included.
		const messages = (result?.diags ?? []).map(
			(d: { message: string }) => d.message,
		);
		// Primary must be included (it answered before grace).
		expect(messages).toContain("primary error");
		// Aux must NOT be included (it didn't answer within grace).
		expect(messages).not.toContain("aux finding");
	});

	it("includes aux diagnostics when aux answers within grace", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Primary settles at 100ms, aux settles at 400ms (within 500ms grace).
		const primaryClient = makeClient(100, [makeDiagnostic("primary error")], {
			serverId: "ts-primary",
		});
		const auxClient = makeClient(400, [makeDiagnostic("aux finding")], {
			serverId: "opengrep-aux",
		});

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);

		const touchPromise = service.touchFile(FILE, "content2", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// Advance past primary (100ms) + aux (400ms) — all within grace (500ms).
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(10);

		const result = await touchPromise;
		const messages = (result?.diags ?? []).map(
			(d: { message: string }) => d.message,
		);
		// Both must be present — aux answered within grace.
		expect(messages).toContain("primary error");
		expect(messages).toContain("aux finding");
	});

	it("gives an auxiliary its declared budget up to the global ceiling", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primaryClient = makeClient(100, [makeDiagnostic("primary error")], {
			serverId: "ts-primary",
		});
		// Opengrep's declared 3500ms budget exceeds the 2000ms global aux ceiling,
		// but its measured ~1.3s warm scan must no longer be cut off at 500ms.
		const auxClient = makeClient(1300, [makeDiagnostic("aux finding")], {
			serverId: "opengrep",
		});

		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);
		const touchPromise = service.touchFile(FILE, "content-budget", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		await vi.advanceTimersByTimeAsync(1310);
		const result = await touchPromise;
		expect(result).toBeDefined();
		expect(result?.diags.map((diagnostic) => diagnostic.message)).toContain(
			"aux finding",
		);
	});

	it("still waits for slow primary even if aux settles early", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Aux settles fast; primary is slow.
		const primaryClient = makeClient(1200, [makeDiagnostic("primary error")], {
			serverId: "ts-primary",
		});
		const auxClient = makeClient(50, [makeDiagnostic("aux finding")], {
			serverId: "opengrep-aux",
		});

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);

		const touchPromise = service.touchFile(FILE, "content3", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// At 600ms: aux is done (50ms), grace would have expired, but PRIMARY is
		// still pending (1200ms). The touch must NOT have resolved yet.
		await vi.advanceTimersByTimeAsync(600);
		let resolved = false;
		touchPromise.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		// Advance to primary settling.
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(10);

		const result = await touchPromise;
		const messages = (result?.diags ?? []).map(
			(d: { message: string }) => d.message,
		);
		expect(messages).toContain("primary error");
	});

	it("carries a late bound auxiliary publication into the next unchanged read", async () => {
		const content = "const value = 1;";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeLateBoundClient(content));
		await service.getClientsForFile(FILE);

		const first = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		expect((await first)?.diags).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(400);

		const next = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		expect((await next)?.diags.map((diagnostic) => diagnostic.message)).toContain(
			"late aux finding",
		);
	});

	it("rejects a late auxiliary publication when the next read changes content", async () => {
		const oldContent = "const value = 1;";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeLateBoundClient(oldContent));
		await service.getClientsForFile(FILE);

		const first = service.touchFile(FILE, oldContent, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		await first;
		await vi.advanceTimersByTimeAsync(400);

		const next = service.touchFile(FILE, "const value = 2;", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		expect((await next)?.diags).toHaveLength(0);
	});

	it("logs a cut-off auxiliary outcome when the grace timer wins the race", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeClient(3000, [], { serverId: "opengrep" }));
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, "telemetry", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		await touch;

		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_aux_wait_outcome",
				metadata: expect.objectContaining({
					outcomes: [
						expect.objectContaining({
							serverId: "opengrep",
							// #1458 S1: the grace timer (2000ms) wins over the aux's own
							// 3000ms wait — "cut_off", not "settled"/"answered".
							outcome: "cut_off",
							budgetMs: 2000,
							elapsedSinceNotifyMs: expect.any(Number),
						}),
					],
				}),
			}),
		);
	});

	// #1458 S1: `waitForDiagnostics` RESOLVES on its own timeout and never
	// rejects (client.ts) — so a silent auxiliary's promise settling within
	// budget looks, promise-wise, identical to one that actually answered.
	// The outcome must be decided from EVIDENCE (a `diagnosticsVersion` bump)
	// rather than from whether the raced promise settled before the grace
	// timer. Reproduces the reviewer's repro: primary settles, opengrep
	// settles silently (no publish) well within its budget — must record
	// "silent", never "answered"/"settled".
	it("does not record a silent auxiliary as answered (evidence-based outcome)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		// Primary settles at 800ms. Aux's OWN wait resolves at 900ms (well
		// within its ~2000ms budget) but publishes NOTHING — this is the
		// "silent scanner" case: the promise settles, but no evidence exists
		// that a publication landed.
		createLSPClient
			.mockResolvedValueOnce(
				makeClient(800, [makeDiagnostic("primary error")], {
					serverId: "ts-primary",
				}),
			)
			.mockResolvedValueOnce(makeClient(900, [], { serverId: "opengrep" }));
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, "silent-aux", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(800);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(10);
		await touch;

		const call = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		);
		expect(call).toBeDefined();
		const outcomes = call?.[0]?.metadata?.outcomes as
			| Array<{ serverId: string; outcome: string }>
			| undefined;
		expect(outcomes).toEqual([
			expect.objectContaining({ serverId: "opengrep", outcome: "silent" }),
		]);
		// The mutation this pins against: recording the outcome as "settled"
		// whenever the raced promise resolves (rather than from evidence) would
		// mark this silent scanner "answered"/"settled" — it must not.
		expect(outcomes?.[0]?.outcome).not.toBe("answered");
		expect(outcomes?.[0]?.outcome).not.toBe("settled");
	});

	it("rejects a version-less late auxiliary publication (recordBinding fails closed, #1458 S7)", async () => {
		const content = "const value = 1;";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeVersionlessLateClient());
		await service.getClientsForFile(FILE);

		const first = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		expect((await first)?.diags).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(400);

		const next = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		// The auxiliary DID publish (getDiagnostics now returns a finding), but
		// the publish was version-less, so no binding was ever recorded —
		// carry must fail closed rather than replay an unverifiable result.
		expect((await next)?.diags).toHaveLength(0);
	});
});

describe("R8 — aux grace: getDiagnostics with-auxiliary path (#1458 S2 extend)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	// #1458 S2: the SECOND aux-wait implementation (raceToCompletion, used by
	// LSPService.getDiagnostics — the path actionable-warnings.ts hits on a
	// content-hash cache miss) used to hand every auxiliary a flat 500ms
	// grace regardless of its declared budget, starving the exact same
	// opengrep warm-run figure the touchFile fix (S2 above) was built around.
	// Extending PromiseDescriptor.budgetMs to raceToCompletion closes that
	// second lane with the identical declared-budget-capped-by-ceiling shape.
	it("includes a warm auxiliary (1300ms) that a flat 500ms default would have starved", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(
				makeClient(100, [makeDiagnostic("primary error")], {
					serverId: "ts-primary",
				}),
			)
			.mockResolvedValueOnce(
				makeClient(1300, [makeDiagnostic("aux finding")], {
					serverId: "opengrep",
				}),
			);
		await service.getClientsForFile(FILE);
		createLSPClient.mockReset();

		// "document" mode → 0ms quality grace, so only the aux-grace ceiling
		// governs (matches touchFile's test scenarios and isolates the aux
		// budget behavior from the unrelated early-unblock quality grace).
		const diagnosticsPromise = service.getDiagnostics(FILE, "document");
		await vi.advanceTimersByTimeAsync(1300);
		await vi.advanceTimersByTimeAsync(10);

		const diags = await diagnosticsPromise;
		const messages = diags.map((d) => d.message);
		expect(messages).toContain("primary error");
		expect(messages).toContain("aux finding");
	});
});

describe("R8 — aux grace: raceToCompletion per-role unit tests", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("completes at primary+auxGrace when primary fast and aux slow", async () => {
		const { raceToCompletion } = await import(
			"../../../clients/lsp/aggregation.js"
		);

		const fast = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		const slow = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 1 }), 3000),
		);

		const resultPromise = raceToCompletion(
			[fast, slow],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0, // No additional quality grace
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// Primary settles at 100ms; aux grace starts. At 600ms grace expires.
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		// Should have resolved at ~610ms with only primary result (aux at 3000ms).
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("primary");
	});

	it("includes aux result when it answers within auxGrace", async () => {
		const { raceToCompletion } = await import(
			"../../../clients/lsp/aggregation.js"
		);

		const fast = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 2 }), 400),
		);

		const resultPromise = raceToCompletion(
			[fast, aux],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0,
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// Advance past aux (400ms). Primary settled at 100ms, aux grace = 500ms.
		// Aux answers at 400ms, which is within grace → both included.
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.id).sort()).toEqual(["aux", "primary"]);
	});

	it("primary-only path: aux grace timer never fires", async () => {
		const { raceToCompletion } = await import(
			"../../../clients/lsp/aggregation.js"
		);
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

		const p1 = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "a", count: 1 }), 50),
		);
		const p2 = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "b", count: 1 }), 80),
		);

		const resultPromise = raceToCompletion(
			[p1, p2],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 1500,
				graceMs: 0,
				// No descriptors with role:"auxiliary" → aux-grace path not entered.
				descriptors: [{ role: "primary" }, { role: "primary" }],
				auxGraceMs: 500,
			},
		);

		const callCountBefore = setTimeoutSpy.mock.calls.length;

		await vi.advanceTimersByTimeAsync(80);
		await vi.advanceTimersByTimeAsync(10);
		await resultPromise;

		// No NEW setTimeout calls beyond the hard-timeout one set up at entry
		// should be for the aux grace (500ms). Verify by checking that no
		// 500ms setTimeout was scheduled.
		const newCalls = setTimeoutSpy.mock.calls.slice(callCountBefore);
		const auxGraceTimers = newCalls.filter(([, ms]) => ms === 500);
		expect(auxGraceTimers).toHaveLength(0);
	});

	it("slow primary: aux settling early does not finalize the race early", async () => {
		const { raceToCompletion } = await import(
			"../../../clients/lsp/aggregation.js"
		);

		// Aux resolves fast; primary is slow.
		const primary = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 0 }), 1200),
		);
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 5 }), 50),
		);

		const resultPromise = raceToCompletion(
			[primary, aux],
			// shouldComplete triggers when any has count > 0 — aux satisfies it at 50ms.
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0, // No quality grace
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// At 600ms: aux is done (50ms), aux grace has expired, but PRIMARY is
		// still pending (1200ms). Race must NOT have resolved yet — primary is
		// not settled so aux-grace can't have started.
		let resolved = false;
		resultPromise.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		// Advance past primary.
		await vi.advanceTimersByTimeAsync(700);
		await vi.advanceTimersByTimeAsync(10);
		const result = await resultPromise;
		expect(result.find((r) => r.id === "primary")).toBeDefined();
	});
});

/**
 * #1470 — a cut-off auxiliary must not yield a conclusive touch.
 *
 * The three-way probe the #1458 review used, promoted from telemetry into the
 * touch's own honesty state. What the touch CLAIMS in each case, as of this
 * change:
 *
 *   - published within grace       → `confirmation: "confirmed"` (correct)
 *   - hung, grace timer wins       → `confirmation: "partial"` naming it (fixed here)
 *   - silent inside its own budget → `confirmation: "confirmed"` (STILL WRONG)
 *
 * The pre-fix defect this change closes: the hung case resolved
 * `confirmation: "confirmed"` with `inconclusive: undefined`, so a hung opengrep
 * read as confirmed-clean on the security lane.
 *
 * The third line is a KNOWN, SEPARATELY FILED GAP (#1493), not a claim of
 * correctness: a silent scanner carries exactly as little evidence as a hung one
 * and still reads as clean. It is the same #533 class in the same lane, neither
 * introduced nor closed by #1470, and the probe below pins today's wrong answer
 * so #1493's fix has to come through this file.
 */
describe("#1470 — cut-off auxiliary honesty", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	/**
	 * Drives one touch with a primary that answers at 800ms and a single
	 * auxiliary whose own wait settles at `auxDelayMs`, then returns both the
	 * touch result and the `lsp_aux_wait_outcome` row it produced — so each probe
	 * can assert that the telemetry outcome and the claimed confirmation agree.
	 */
	async function probe(
		auxDelayMs: number,
		auxDiags: ReturnType<typeof makeDiagnostic>[],
	) {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(
				makeClient(800, [], { serverId: "ts-primary" }),
			)
			.mockResolvedValueOnce(
				makeClient(auxDelayMs, auxDiags, { serverId: "opengrep" }),
			);
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, "probe", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		// 800 (primary) + 2000 (aux ceiling) + slack covers every probe.
		await vi.advanceTimersByTimeAsync(3000);
		const result = await touch;
		const outcomes = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		)?.[0]?.metadata?.outcomes as
			| Array<{ serverId: string; outcome: string }>
			| undefined;
		return { result, outcome: outcomes?.[0]?.outcome };
	}

	it("a HUNG auxiliary (cut_off) narrows the confirmation and names the server", async () => {
		// Aux wait outlives the 2000ms ceiling → our grace timer wins.
		const { result, outcome } = await probe(3000, [makeDiagnostic("never")]);
		expect(outcome).toBe("cut_off");
		// The defect: this was "confirmed" with no coverage caveat at all.
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		// NARROWED, not collapsed — the primary answered, so the touch is not
		// inconclusive and its diagnostics are not discarded (#533 cuts both ways).
		expect(result?.inconclusive).toBeUndefined();
	});

	// CLASS SWEEP (#1470's own acceptance criterion). opengrep is the scanner the
	// issue was reported against, and under today's DEFAULTS it is the only
	// auxiliary that can reach the cut-off shape: `budgetMs = Math.min(
	// timeoutFor(id), auxCeilingMs)` (index.ts), and the aux's OWN
	// `waitForDiagnostics` timer is armed when `perServerWaits` is built —
	// strictly before the grace timer, which is armed only after
	// `Promise.all(primaryWaits)`. So when the two budgets are equal the aux's
	// own timer always resolves first and the race reads "answered", never
	// "cut_off". `cut_off` therefore requires the ceiling to be STRICTLY LESS
	// than the declared budget: opengrep (3500) qualifies against the 2000
	// default; zizmor (2000) never can, and ast-grep (1800) and typos (1500)
	// cannot either.
	//
	// What those three do INSTEAD is NOT "read as inconclusive". A silent
	// auxiliary that settles inside its own budget still yields
	// `confirmation: "confirmed"` with no coverage caveat — the sibling probe
	// below pins that, and it is the separately filed #1493. #1470 neither
	// introduces nor closes it.
	//
	// The cut-off boundary is a property of today's numbers, not of the code:
	// `PI_LENS_AUX_GRACE_MS` moves the ceiling for every auxiliary, and any budget
	// change moves the boundary. So the narrowing is keyed on `role ===
	// "auxiliary"` — the same predicate that builds `auxWaits` — never on a server
	// id. Lowering the ceiling puts each of the four into the cut-off shape and
	// each must narrow identically.
	it.each(["opengrep", "ast-grep", "zizmor", "typos"])(
		"narrows the confirmation for a cut-off %s, not just opengrep",
		async (auxId) => {
			// Ceiling well under every declared budget, so the grace timer wins with
			// the touch's own deadline (the aux's declared budget) still far away.
			process.env.PI_LENS_AUX_GRACE_MS = "300";
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			getServersForFileWithConfig.mockReturnValue([
				makePrimaryServer("ts-primary"),
				makeAuxServer(auxId),
			]);
			createLSPClient
				.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
				.mockResolvedValueOnce(makeClient(9000, [], { serverId: auxId }));
			await service.getClientsForFile(FILE);

			const touch = service.touchFile(FILE, "sweep", {
				clientScope: "with-auxiliary",
				auxiliaryServerIds: [auxId],
				collectDiagnostics: true,
				diagnostics: "document",
			});
			await vi.advanceTimersByTimeAsync(500);
			const result = await touch;
			expect(result?.confirmation).toBe("partial");
			expect(result?.unconfirmedServerIds).toEqual([auxId]);
		},
	);

	it("KNOWN GAP (#1493): a SILENT auxiliary STILL reads as confirmed clean — #1470 narrows only cut_off", async () => {
		// Aux settles at 900ms, inside its own budget, publishing nothing — the
		// same silent-scanner shape #1458's evidence-based outcome test uses.
		//
		// This asserts what is TRUE TODAY, not what should be true. The touch
		// resolves `confirmation: "confirmed"` with an empty `diags` and no
		// `inconclusive` flag, so a scanner that said nothing at all reads as a
		// clean bill of health — the #533 class, in the same lane, arriving through
		// a different door than #1470's cut_off. It is NOT introduced by #1470 and
		// NOT fixed by it; it is filed separately as #1493.
		//
		// The assertion #1470 actually owns is the last one: a silent aux must not
		// acquire a cut_off coverage gap it did not earn. The confirmed/inconclusive
		// assertions above it are a REGRESSION FENCE for #1493 — when that issue is
		// fixed this test must fail, and the fix should rewrite it to assert the
		// narrowed verdict rather than delete it.
		const { result, outcome } = await probe(900, []);
		expect(outcome).toBe("silent");
		expect(result?.confirmation).toBe("confirmed"); // #1493: the false clean
		expect(result?.inconclusive).toBeUndefined(); // #1493: not even flagged
		expect(result?.diags).toEqual([]);
		// #1470's own contract: no cut_off gap was earned here.
		expect(result?.unconfirmedServerIds).toBeUndefined();
	});

	it("an auxiliary that PUBLISHES within grace still yields an unqualified confirmation", async () => {
		const { result, outcome } = await probe(
			900,
			[makeDiagnostic("aux finding")],
		);
		expect(outcome).toBe("answered");
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
		expect(
			(result?.diags ?? []).map((d: { message: string }) => d.message),
		).toContain("aux finding");
	});

	it("records the narrowed verdict on the same lsp_touch_file row as auxCutOffServerIds", async () => {
		// Observability contract from the issue: a `cut_off` row must coincide
		// with a touch that no longer claims confirmation for that server. Both
		// facts have to be readable from latency.log without a code read.
		await probe(3000, [makeDiagnostic("never")]);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					confirmation: "partial",
					auxCutOffServerIds: ["opengrep"],
					inconclusive: false,
				}),
			}),
		);
	});

	it("does not prime the last-known cache from a partially covered touch", async () => {
		// #570's wipe class re-entering through the cut-off door: the merged array
		// is missing whatever the cut-off scanner would have said, so an empty one
		// must not delete a previously-confirmed record and a non-empty one must
		// not be replayed as an authoritative observation.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(
				makeClient(100, [makeDiagnostic("primary error")], {
					serverId: "ts-primary",
				}),
			)
			.mockResolvedValueOnce(makeClient(3000, [], { serverId: "opengrep" }));
		await service.getClientsForFile(FILE);

		const content = "cache-probe";
		const touch = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(3000);
		const result = await touch;
		expect(result?.confirmation).toBe("partial");
		expect(
			service.getLastKnownDiagnostics(FILE, hashDiagnosticContent(content)),
		).toBeUndefined();
	});
});
