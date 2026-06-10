/**
 * Tests for #190 Phase 1 — per-session diagnostic state persistence + the
 * widget-state export/import that backs resume rehydration.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	loadSessionState,
	saveSessionState,
} from "../../clients/session-state-store.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnosticSummaries,
	importWidgetState,
	recordDiagnostics,
} from "../../clients/widget-state.js";

let dataDir: string;
let prevDataDir: string | undefined;
const cwd = "/proj/example";

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pi-lens-session-store-"));
	prevDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = dataDir;
});

afterAll(() => {
	if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = prevDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => clearWidgetState());

function seedDiagnostics() {
	recordDiagnostics("/proj/example/a.ts", [
		{ tool: "tsc", severity: "error", semantic: "blocking", message: "boom", line: 5 },
	]);
	recordDiagnostics("/proj/example/b.ts", [
		{ tool: "eslint", severity: "warning", message: "meh", line: 2, rule: "no-x" },
	]);
}

describe("widget-state export/import (#190)", () => {
	it("round-trips the per-file diagnostic state", () => {
		seedDiagnostics();
		const before = getFileDiagnosticSummaries();
		expect(before).toHaveLength(2);

		const snapshot = exportWidgetState();
		clearWidgetState();
		expect(getFileDiagnosticSummaries()).toEqual([]);

		expect(importWidgetState(snapshot)).toBe(true);
		expect(getFileDiagnosticSummaries()).toEqual(before);
	});

	it("rejects a snapshot from a different version (no partial import)", () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		clearWidgetState();
		expect(importWidgetState({ ...snapshot, version: 999 })).toBe(false);
		expect(getFileDiagnosticSummaries()).toEqual([]);
	});

	it("does NOT persist lspServers (process-bound) — only files + languages", () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		expect(Object.keys(snapshot)).toEqual(
			expect.arrayContaining(["version", "sessionLanguages", "files"]),
		);
		expect(
			(snapshot as unknown as Record<string, unknown>).lspServers,
		).toBeUndefined();
	});
});

describe("session-state-store save/load (#190)", () => {
	it("persists and reloads a session's widget snapshot keyed by session id", async () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		await saveSessionState(cwd, "019ead34-uuid", snapshot);

		const loaded = await loadSessionState(cwd, "019ead34-uuid");
		expect(loaded?.sessionId).toBe("019ead34-uuid");
		expect(loaded?.widget).toEqual(snapshot);
	});

	it("returns undefined for an unknown or empty session id", async () => {
		expect(await loadSessionState(cwd, "never-saved")).toBeUndefined();
		expect(await loadSessionState(cwd, "")).toBeUndefined();
		expect(await loadSessionState(cwd, undefined)).toBeUndefined();
	});

	it("save is a no-op for a missing session id (no throw)", async () => {
		await expect(
			saveSessionState(cwd, undefined, exportWidgetState()),
		).resolves.toBeUndefined();
		await expect(
			saveSessionState(cwd, "", exportWidgetState()),
		).resolves.toBeUndefined();
	});

	it("end-to-end resume flow: save → clear → load → import restores findings", async () => {
		seedDiagnostics();
		const before = getFileDiagnosticSummaries();
		await saveSessionState(cwd, "resume-me", exportWidgetState());

		// Simulate a fresh process: nothing in memory.
		clearWidgetState();
		expect(getFileDiagnosticSummaries()).toEqual([]);

		// Resume: load by the same stable id and rehydrate.
		const loaded = await loadSessionState(cwd, "resume-me");
		expect(importWidgetState(loaded?.widget)).toBe(true);
		expect(getFileDiagnosticSummaries()).toEqual(before);
	});

	it("isolates sessions: one id's state does not leak into another", async () => {
		seedDiagnostics();
		await saveSessionState(cwd, "session-A", exportWidgetState());

		clearWidgetState();
		recordDiagnostics("/proj/example/c.ts", [
			{ tool: "ruff", severity: "error", message: "other", line: 1 },
		]);
		await saveSessionState(cwd, "session-B", exportWidgetState());

		const a = await loadSessionState(cwd, "session-A");
		const b = await loadSessionState(cwd, "session-B");
		expect(a?.widget.files.map((f) => f.filePath).sort()).toEqual([
			"/proj/example/a.ts",
			"/proj/example/b.ts",
		]);
		expect(b?.widget.files.map((f) => f.filePath)).toEqual([
			"/proj/example/c.ts",
		]);
	});
});
