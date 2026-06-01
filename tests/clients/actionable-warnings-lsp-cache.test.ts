import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LSP service mock — collects which methods were called so we can assert that
// the slow path is skipped when the cache is hot.
const openFile = vi.fn(async () => undefined);
const getDiagnostics = vi.fn(async () => []);
const codeAction = vi.fn(async () => []);
let lastKnownReturn: unknown[] | undefined = undefined;
const getLastKnownDiagnostics = vi.fn(() => lastKnownReturn);

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		supportsLSP: (filePath: string) => filePath.endsWith(".ts"),
		openFile,
		getDiagnostics,
		codeAction,
		getLastKnownDiagnostics,
	}),
}));

let tmpDir: string;

beforeEach(() => {
	openFile.mockClear();
	getDiagnostics.mockClear();
	codeAction.mockClear();
	getLastKnownDiagnostics.mockClear();
	lastKnownReturn = undefined;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aw-cache-"));
	const src = path.join(tmpDir, "src");
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(
		path.join(src, "main.ts"),
		"export function main(): void {}\n",
	);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function buildReport(args: { dispatchWarnings?: never[] } = {}) {
	const { buildActionableWarningsReport } = await import(
		"../../clients/actionable-warnings.js"
	);
	return buildActionableWarningsReport({
		cwd: tmpDir,
		sessionId: "lens-test",
		turnIndex: 1,
		files: ["src/main.ts"],
		modifiedRangesByFile: new Map(),
		dispatchWarnings: args.dispatchWarnings ?? [],
		includeLspCodeActions: true,
	});
}

describe("actionable-warnings LSP cache short-circuit (#fix-1)", () => {
	it("uses the cached LSP diagnostics when getLastKnownDiagnostics returns a value", async () => {
		lastKnownReturn = []; // cache present, file has no LSP diagnostics
		await buildReport();
		expect(getLastKnownDiagnostics).toHaveBeenCalledTimes(1);
		expect(openFile).not.toHaveBeenCalled();
		expect(getDiagnostics).not.toHaveBeenCalled();
	});

	it("uses cached diagnostics even when they include real warnings (no fresh round trip)", async () => {
		lastKnownReturn = [
			{
				severity: 2,
				message: "Some warning",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
				source: "ts",
			},
		];
		await buildReport();
		expect(getLastKnownDiagnostics).toHaveBeenCalledTimes(1);
		expect(openFile).not.toHaveBeenCalled();
		expect(getDiagnostics).not.toHaveBeenCalled();
		expect(codeAction).toHaveBeenCalledTimes(1);
	});

	it("falls through to the slow path only when the cache is empty (undefined)", async () => {
		lastKnownReturn = undefined; // cache miss — dispatch never touched this file
		await buildReport();
		expect(getLastKnownDiagnostics).toHaveBeenCalledTimes(1);
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(getDiagnostics).toHaveBeenCalledTimes(1);
	});

	it("distinguishes 'cache empty' (`[]`) from 'cache missing' (undefined)", async () => {
		// Empty cache is a real result — file is LSP-clean — and must not trigger
		// a re-fetch. The fix would regress if `[]` was confused with undefined.
		lastKnownReturn = [];
		await buildReport();
		expect(openFile).not.toHaveBeenCalled();
		expect(getDiagnostics).not.toHaveBeenCalled();
	});
});
