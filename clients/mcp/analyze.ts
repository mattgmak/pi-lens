/**
 * Host-neutral analysis facade for the MCP path.
 *
 * This is the heart of the "real review loop": it runs the *same* per-edit
 * dispatch pipeline pi-lens runs inside pi (`dispatchLintWithResult`) on a file,
 * and returns a structured, JSON-serializable result — diagnostics plus the
 * latency record for that dispatch, in the same schema pi writes to latency.log.
 *
 * Because the only host coupling is `getFlag` (see host-shim), this runs with no
 * pi process: an MCP server (or a `fresh` worker importing the freshly-built
 * dist) can drive it directly, letting Claude observe a commit's real behavioral
 * + perf impact first-hand rather than inferring it from pasted logs.
 */

import * as path from "node:path";
import {
	dispatchLintWithResult,
	getLatencyReports,
} from "../dispatch/integration.js";
import type { Diagnostic } from "../dispatch/types.js";
import { createMcpHost } from "./host-shim.js";

/** One diagnostic, flattened to the fields an MCP consumer needs. */
export interface McpAnalyzeDiagnostic {
	line?: number;
	column?: number;
	severity: Diagnostic["severity"];
	semantic: Diagnostic["semantic"];
	tool: string;
	rule?: string;
	code?: string;
	message: string;
	fixable?: boolean;
	fixSuggestion?: string;
}

/** Per-runner timing, mirroring the latency.log `runners[]` schema. */
export interface McpRunnerLatency {
	runnerId: string;
	durationMs: number;
	status: string;
	diagnosticCount: number;
}

export interface McpAnalyzeResult {
	filePath: string;
	cwd: string;
	fileKind: string | undefined;
	/** Wall-clock time the facade spent in dispatch (includes provider warmup). */
	durationMs: number;
	hasBlockers: boolean;
	counts: {
		diagnostics: number;
		blockers: number;
		warnings: number;
		fixed: number;
	};
	diagnostics: McpAnalyzeDiagnostic[];
	/** The dispatch latency report for this run (latency.log schema), if captured. */
	latency?: {
		totalDurationMs: number;
		stoppedEarly: boolean;
		runners: McpRunnerLatency[];
	};
}

export interface AnalyzeFileOptions {
	/** Per-call flag overrides for the host shim (e.g. `{ "no-lsp": true }`). */
	flags?: Record<string, boolean | string | undefined>;
}

function toMcpDiagnostic(diagnostic: Diagnostic): McpAnalyzeDiagnostic {
	return {
		line: diagnostic.line,
		column: diagnostic.column,
		severity: diagnostic.severity,
		semantic: diagnostic.semantic,
		tool: diagnostic.tool,
		rule: diagnostic.rule,
		code: diagnostic.code,
		message: diagnostic.message,
		fixable: diagnostic.fixable,
		fixSuggestion: diagnostic.fixSuggestion,
	};
}

/**
 * Run the per-edit pipeline on `filePath` and return a structured result.
 *
 * The latency report is matched against the dispatches appended *during this
 * call* (we snapshot the report count first), so concurrent callers don't pick
 * up each other's timings.
 */
export async function analyzeFile(
	filePath: string,
	cwd: string,
	options: AnalyzeFileOptions = {},
): Promise<McpAnalyzeResult> {
	const absPath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(cwd, filePath);
	const host = createMcpHost(options.flags);

	const reportsBefore = getLatencyReports().length;
	const start = Date.now();
	const result = await dispatchLintWithResult(absPath, cwd, host);
	const durationMs = Date.now() - start;

	// dispatchForFile appended a latency report during the call above. Match the
	// newly-added report for this exact path; fall back to the most recent new
	// report if the path normalization differs.
	const newReports = getLatencyReports().slice(reportsBefore);
	const latencyReport =
		newReports.find((report) => path.resolve(report.filePath) === absPath) ??
		newReports[newReports.length - 1];

	return {
		filePath: absPath,
		cwd,
		fileKind: latencyReport?.fileKind,
		durationMs,
		hasBlockers: result.hasBlockers,
		counts: {
			diagnostics: result.diagnostics.length,
			blockers: result.blockers.length,
			warnings: result.warnings.length,
			fixed: result.fixed.length,
		},
		diagnostics: result.diagnostics.map(toMcpDiagnostic),
		latency: latencyReport
			? {
					totalDurationMs: latencyReport.totalDurationMs,
					stoppedEarly: latencyReport.stoppedEarly,
					runners: latencyReport.runners.map((runner) => ({
						runnerId: runner.runnerId,
						durationMs: runner.durationMs,
						status: runner.status,
						diagnosticCount: runner.diagnosticCount,
					})),
				}
			: undefined,
	};
}
