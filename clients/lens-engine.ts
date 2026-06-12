/**
 * LensEngine — the single internal-facing seam for pi-lens host adapters.
 *
 * The maintainability rule: host adapters (the MCP server today; index.ts can
 * adopt incrementally) talk ONLY to this module, never reaching into pi-lens
 * internals directly. So when an internal API is refactored, the break surfaces
 * HERE (one file, TypeScript-loud), not scattered across the adapter. New
 * mirrored capabilities (cascade, call-graph, …) get a method here and the
 * adapter just routes to it — coupling stays capped at this interface instead of
 * growing per tool.
 *
 * It re-exports the per-concern facades (analyze / review / session / ipc) and
 * adds thin wrappers over the remaining internal reach-ins (latency, project
 * scan, LSP status, diagnostic stats, LSP config).
 */

import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import {
	type DispatchLatencyReport,
	getLatencyReports,
} from "./dispatch/integration.js";
import { initLSPConfig } from "./lsp/config.js";
import { getLSPService } from "./lsp/index.js";
import { scanProjectDiagnostics } from "./project-diagnostics/scanner.js";
import type { ProjectDiagnosticsSnapshot } from "./project-diagnostics/types.js";

// --- Facades (re-exported so adapters import only this module) ---------------

export {
	analyzeFile,
	type AnalyzeFileOptions,
	type McpAnalyzeResult,
} from "./mcp/analyze.js";
export { createMcpHost } from "./mcp/host-shim.js";
export {
	ipcPathForCwd,
	requestWarmAnalyze,
	type WarmAnalyzeRequest,
} from "./mcp/ipc.js";
export {
	analyzeFileFresh,
	resolveRebuildScript,
	runRebuild,
	type ScanDiagnostic,
	summarizeScan,
} from "./mcp/review.js";
export {
	runSessionStart,
	runTurnEnd,
	type SessionStartOutcome,
	type TurnEndOutcome,
} from "./mcp/session.js";

// --- Query wrappers (own the remaining internal reach-ins) -------------------

/** Recent dispatch latency reports (latency.log schema), newest first. */
export function recentLatency(
	limit = 5,
	fileFilter?: string,
): DispatchLatencyReport[] {
	let reports = getLatencyReports();
	if (fileFilter) {
		const needle = fileFilter.replace(/\\/g, "/");
		reports = reports.filter((report) =>
			report.filePath.replace(/\\/g, "/").endsWith(needle),
		);
	}
	return reports.slice(-limit).reverse();
}

/** Cheap project-wide scan (tree-sitter + fact rules). */
export function projectScan(
	cwd: string,
	maxFiles?: number,
): Promise<ProjectDiagnosticsSnapshot> {
	return scanProjectDiagnostics({ cwd, tier: "cheap", maxFiles });
}

export interface LspStatus {
	aliveClients: number;
	servers: Array<{ serverId: string; root: string; connected: boolean }>;
}

/** Alive LSP client count + per-server status. */
export function lspStatus(): LspStatus {
	const lsp = getLSPService();
	return { aliveClients: lsp.getAliveClientCount(), servers: lsp.getStatus() };
}

/** Session diagnostic counters (shown / auto-fixed / unresolved …). */
export function diagnosticStats(): ReturnType<
	ReturnType<typeof getDiagnosticTracker>["getStats"]
> {
	return getDiagnosticTracker().getStats();
}

/** Initialise LSP config for a workspace (idempotent at the LSP layer). */
export function ensureLspConfig(cwd: string): Promise<void> {
	return initLSPConfig(cwd);
}
