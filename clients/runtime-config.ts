/**
 * Central runtime tuning knobs for pipeline/dispatch behavior.
 * Keep these values in one place so behavior is consistent and easy to tune.
 */

/**
 * Minimum wall-clock budget for every dispatch runner. Acts as a floor:
 * effective timeout = max(runner.timeoutMs ?? 30_000, RUNNER_TIMEOUT_FLOOR_MS).
 *
 * Resolution order (highest priority first):
 *   1. `dispatch.runnerTimeoutMs` in `~/.pi-lens/config.json`
 *   2. `PI_LENS_RUNNER_TIMEOUT_MS` environment variable
 *   3. 0 (no floor — runner budgets and the 30 s default apply as-is)
 *
 * @example ~/.pi-lens/config.json
 * ```json
 * { "dispatch": { "runnerTimeoutMs": 180000 } }
 * ```
 *
 * @example env var
 * ```bash
 * PI_LENS_RUNNER_TIMEOUT_MS=180000 pi
 * ```
 */
import { loadPiLensGlobalConfig } from "./lens-config.js";
const _globalConfig = loadPiLensGlobalConfig();
const _configFloor = _globalConfig?.dispatch?.runnerTimeoutMs ?? 0;
const _envFloor = Number(process.env.PI_LENS_RUNNER_TIMEOUT_MS);
export const RUNNER_TIMEOUT_FLOOR_MS = Math.max(_configFloor, _envFloor, 0);

export const RUNTIME_CONFIG = {
	pipeline: {
		lspMaxFileBytes: 2 * 1024 * 1024,
		lspMaxFileLines: 5000,
		cascadeMaxFiles: 5,
		cascadeMaxDiagnosticsPerFile: 20,
		// Hard cap on how long the pipeline will wait for an LSP client to spawn.
		// Keeps tool_result from blocking the TUI during cold LSP start (e.g.
		// pyright workspace indexing). The LSP server continues spawning in the
		// background; subsequent edits get full diagnostics once it is ready.
		lspSpawnBudgetMs: 5_000,
	},
	dispatch: {
		runnerTimeoutMs: 30_000,
	},
	crashNotice: {
		alwaysShowFirstN: 2,
		showEveryNth: 5,
	},
	reviewGraph: {
		maxFiles: 1_000,
		maxFileBytes: 1 * 1024 * 1024,
	},
	turnEnd: {
		maxLines: 20,
		maxChars: 1000,
	},
} as const;
