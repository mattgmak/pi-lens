/**
 * analyzeFile facade: runs the real per-edit dispatch pipeline and maps the
 * DispatchResult + latency report into the JSON contract the MCP server returns.
 *
 * dispatchForFile + getLatencyReports are mocked (as in the dispatch-integration
 * suite) so the test asserts the *mapping*, not real runner execution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchLatencyReport } from "../../../clients/dispatch/dispatcher.js";

vi.mock("../../../clients/dispatch/dispatcher.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/dispatcher.js")
		>();
	return {
		...mod,
		dispatchForFile: vi.fn(),
		getLatencyReports: vi.fn(() => []),
	};
});

vi.mock("../../../clients/dispatch/fact-runner.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/fact-runner.js")
		>();
	return { ...mod, runProviders: vi.fn() };
});

import { dispatchForFile, getLatencyReports } from "../../../clients/dispatch/dispatcher.js";
import { resetDispatchBaselines } from "../../../clients/dispatch/integration.js";
import { analyzeFile } from "../../../clients/mcp/analyze.js";

const warningDiagnostic = {
	id: "warn-1",
	message: "Unused import",
	filePath: "app.ts",
	line: 3,
	column: 1,
	severity: "warning" as const,
	semantic: "warning" as const,
	tool: "biome",
	rule: "noUnusedImports",
	fixable: true,
	fixSuggestion: "Remove the import",
};

const blockingDiagnostic = {
	id: "err-1",
	message: "Type error",
	filePath: "app.ts",
	line: 1,
	severity: "error" as const,
	semantic: "blocking" as const,
	tool: "tsc",
};

let tmpDir: string;
let tsFile: string;

beforeEach(() => {
	resetDispatchBaselines();
	vi.mocked(dispatchForFile).mockReset();
	vi.mocked(getLatencyReports).mockReset();
	vi.mocked(getLatencyReports).mockReturnValue([]);
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-analyze-"));
	tsFile = path.join(tmpDir, "app.ts");
	fs.writeFileSync(tsFile, "export const a = 1;\n");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("analyzeFile", () => {
	it("maps DispatchResult diagnostics and counts into the MCP contract", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue({
			diagnostics: [blockingDiagnostic, warningDiagnostic],
			blockers: [blockingDiagnostic],
			warnings: [warningDiagnostic],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "1 error, 1 warning",
			blockerOutput: "1 error",
			hasBlockers: true,
		});

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.filePath).toBe(tsFile);
		expect(result.cwd).toBe(tmpDir);
		expect(result.hasBlockers).toBe(true);
		expect(result.counts).toEqual({
			diagnostics: 2,
			blockers: 1,
			warnings: 1,
			fixed: 0,
		});
		// Diagnostics flattened with the fields an MCP consumer needs.
		const warn = result.diagnostics.find((d) => d.rule === "noUnusedImports");
		expect(warn).toMatchObject({
			line: 3,
			severity: "warning",
			semantic: "warning",
			tool: "biome",
			fixable: true,
			fixSuggestion: "Remove the import",
		});
		expect(typeof result.durationMs).toBe("number");
	});

	it("attaches the latency report appended during this dispatch", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue({
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		});

		const report: DispatchLatencyReport = {
			filePath: tsFile,
			fileKind: "jsts",
			overallStartMs: 0,
			overallEndMs: 1200,
			totalDurationMs: 1200,
			runners: [
				{
					runnerId: "lsp",
					startTime: 0,
					endTime: 1000,
					durationMs: 1000,
					status: "succeeded",
					diagnosticCount: 0,
					semantic: "blocking",
				},
			],
			stoppedEarly: false,
			totalDiagnostics: 0,
			blockers: 0,
			warnings: 0,
		};

		// Empty before the call (length snapshot), the new report after.
		vi.mocked(getLatencyReports)
			.mockReturnValueOnce([])
			.mockReturnValueOnce([report]);

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.fileKind).toBe("jsts");
		expect(result.latency).toEqual({
			totalDurationMs: 1200,
			stoppedEarly: false,
			runners: [
				{
					runnerId: "lsp",
					durationMs: 1000,
					status: "succeeded",
					diagnosticCount: 0,
				},
			],
		});
	});

	it("returns an empty result (no latency) for an unsupported file kind", async () => {
		const csv = path.join(tmpDir, "data.csv");
		fs.writeFileSync(csv, "a,b\n1,2\n");

		const result = await analyzeFile(csv, tmpDir);

		expect(result.counts.diagnostics).toBe(0);
		expect(result.hasBlockers).toBe(false);
		expect(result.latency).toBeUndefined();
		expect(dispatchForFile).not.toHaveBeenCalled();
	});

	it("resolves a relative file path against cwd", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue({
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		});

		const result = await analyzeFile("app.ts", tmpDir);
		expect(result.filePath).toBe(tsFile);
	});
});
