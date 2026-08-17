/**
 * #1266: resetDispatchAvailabilityState() (runner-helpers.ts) was added by
 * PR #1263 to implement #1222's "install-failure suppression lasts until the
 * next session" — but no production code called it, so a transient install
 * failure suppressed a tool for the rest of the process lifetime instead of
 * just the rest of the session. The existing runner-helpers suite only
 * proved the reset helper itself works when called directly, which is
 * exactly why the missing wiring went unnoticed. This test drives real
 * suppression through the public resolver, starts a new session via
 * `handleSessionStart` (never calling the reset helper directly), and
 * asserts the tool is retried afterward.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

vi.mock("../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => undefined),
	// Not spawnable — forces resolveCommandWithInstallFallback down the
	// install-fallback path (rather than the --version probe path) where
	// noteInstallFailure/suppression lives.
	isSpawnableCommand: vi.fn(async () => false),
	resetPathWalkMemo: vi.fn(),
}));

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => ({
		touchFile: vi.fn().mockResolvedValue(undefined),
		supportsLSP: () => false,
	})),
}));

function makeDefaultRuntime() {
	return {
		sessionGeneration: 1,
		isCurrentSession: () => true,
		markStartupScanInFlight: () => {},
		clearStartupScanInFlight: () => {},
		complexityBaselines: new Map(),
		resetForSession: () => {},
		projectRoot: "",
		projectRulesScan: { hasCustomRules: false, rules: [] },
		cachedExports: new Map(),
		errorDebtBaseline: { testsPassed: true, buildPassed: true },
	};
}

function makeDeps(ctxCwd: string) {
	return {
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime: makeDefaultRuntime(),
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
		},
		biomeClient: { isAvailable: () => false, ensureAvailable: async () => false },
		ruffClient: { isAvailable: () => false, ensureAvailable: async () => false },
		knipClient: { isAvailable: () => false, ensureAvailable: async () => false },
		jscpdClient: { isAvailable: () => false, ensureAvailable: async () => false },
		depChecker: { isAvailable: () => false, ensureAvailable: async () => false },
		testRunnerClient: {
			detectRunner: () => ({ runner: "vitest", config: null }),
			runTestFile: () => ({ failed: 1, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

describe("dispatch availability suppression is reset at session start (#1266)", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = setupTestEnvironment("pi-lens-dispatch-reset-").tmpDir;
	});

	afterEach(() => {
		removeTempDirSync(tmpDir);
	});

	it("retries a suppressed tool's install after handleSessionStart, not just after calling the reset helper directly", async () => {
		const { resolveCommandWithInstallFallback } = await import(
			"../../clients/dispatch/runners/utils/runner-helpers.js"
		);
		const installerMod = await import("../../clients/installer/index.js");
		const ensureToolMock = vi.mocked(installerMod.ensureTool);
		ensureToolMock.mockResolvedValue(undefined);

		// stylelint is autoInstall-eligible per tool-policy.ts, so the
		// install-fallback branch (not the config-first early return) runs.
		const first = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			tmpDir,
		);
		expect(first).toBeNull();
		expect(ensureToolMock).toHaveBeenCalledTimes(1);

		// Same-session retry must stay suppressed: the failed install must not
		// become an install attempt again until the session boundary.
		const second = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			tmpDir,
		);
		expect(second).toBeNull();
		expect(ensureToolMock).toHaveBeenCalledTimes(1);

		await handleSessionStart(makeDeps(tmpDir));

		// A new session must clear the suppression and retry the install.
		const third = await resolveCommandWithInstallFallback(
			"stylelint",
			"stylelint",
			tmpDir,
		);
		expect(third).toBeNull();
		expect(ensureToolMock).toHaveBeenCalledTimes(2);
	});
});
