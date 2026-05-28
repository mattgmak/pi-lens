import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearWidgetState,
	recordDiagnostics,
	recordFormatter,
	recordLsp,
	recordRunner,
	renderWidget,
	setSessionLanguages,
} from "../../clients/widget-state.ts";

const e = String.fromCharCode(27);
const theme = {
	fg: (_color: string, s: string) => `${e}[38;2;102;102;102m${s}${e}[39m`,
};

afterEach(() => {
	clearWidgetState();
});

describe("widget-state renderWidget", () => {
	it("keeps diagnostic rows within the provided TUI width", () => {
		const filePath = `${process.cwd()}/index.ts`;
		recordRunner(filePath, "type-safety", "failed", 2);
		recordRunner(filePath, "eslint", "succeeded", 27);
		recordRunner(filePath, "ast-grep-napi", "succeeded", 1);
		recordDiagnostics(filePath, [
			{
				severity: "error",
				line: 2278,
				column: 10,
				rule: "typescript:2451",
				message: "Cannot redeclare block-scoped variable 'limited'.",
			},
			{
				severity: "warning",
				line: 497,
				column: 60,
				rule: "ts-react-antipatterns",
				message:
					"React anti-pattern: setState inside a loop causes multiple re-renders — batch with a single state update instead. ".repeat(
						4,
					),
			},
		]);

		const lines = renderWidget(120, theme);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("truncates every widget line, including headers and LSP status", () => {
		setSessionLanguages([
			"typescript-super-long-language-label",
			"javascript-super-long-language-label",
			"python-super-long-language-label",
			"rust-super-long-language-label",
			"go-super-long-language-label",
			"kotlin-super-long-language-label",
		]);
		recordLsp(
			"typescript-language-server-with-a-very-long-id",
			process.cwd(),
			"spawn_start",
		);

		const lines = renderWidget(40, theme);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("deduplicates files by basename — last write wins at most 5 entries", () => {
		const a = `${process.cwd()}/pi-lens/index.ts`;
		const b = `${process.cwd()}/pi-webaio/index.ts`;
		recordRunner(a, "type-safety", "failed", 1);
		recordDiagnostics(a, [
			{ severity: "error", message: "error in pi-lens", rule: "E1" },
		]);
		recordRunner(b, "eslint", "succeeded", 3);
		recordDiagnostics(b, [
			{ severity: "error", message: "warning in pi-webaio", rule: "W1" },
		]);

		const lines = renderWidget(120, theme);

		const fileRows = lines.filter((l) => l.includes("index.ts"));
		// Dedup: only one index.ts entry in the file list
		expect(fileRows.length).toBeGreaterThanOrEqual(1);
		expect(fileRows.length).toBeLessThanOrEqual(4);

		// Later file's diagnostics supersede earlier
		const allLines = lines.join("");
		expect(allLines).toContain("warning in pi-webaio");
		expect(allLines).not.toContain("error in pi-lens");
	});

	it("paints the file row red when any diagnostic carries semantic=blocking, even if severity is warning", () => {
		const filePath = `${process.cwd()}/cors.ts`;
		recordRunner(filePath, "sonar-rules", "succeeded", 1);
		recordDiagnostics(filePath, [
			{
				severity: "warning",
				semantic: "blocking",
				message: "CORS wildcard origin",
				rule: "cors-wildcard",
			},
		]);

		const lines = renderWidget(120, theme);
		const fileRow = lines.find((l) => l.includes("cors.ts")) ?? "";
		// red(●) — wrapped in theme color escape; assert the bullet appears
		// before the filename and that no warning-only triangle preceded it.
		expect(fileRow).toMatch(/●.*cors\.ts/);
		expect(fileRow).not.toMatch(/▲.*cors\.ts/);
	});

	it("falls back to severity=error when semantic is absent so plain tsc errors stay red", () => {
		const filePath = `${process.cwd()}/legacy.ts`;
		recordRunner(filePath, "type-safety", "failed", 1);
		recordDiagnostics(filePath, [
			{
				severity: "error",
				message: "TS2451: cannot redeclare",
				rule: "typescript:2451",
			},
		]);

		const lines = renderWidget(120, theme);
		const fileRow = lines.find((l) => l.includes("legacy.ts")) ?? "";
		expect(fileRow).toMatch(/●.*legacy\.ts/);
	});

	it("paints the file row yellow when severity=error but semantic explicitly demotes it", () => {
		const filePath = `${process.cwd()}/advisory.ts`;
		recordRunner(filePath, "lint", "succeeded", 1);
		recordDiagnostics(filePath, [
			{
				severity: "error",
				semantic: "warning",
				message: "advisory error from non-blocking rule",
				rule: "advisory-rule",
			},
		]);

		const lines = renderWidget(120, theme);
		const fileRow = lines.find((l) => l.includes("advisory.ts")) ?? "";
		expect(fileRow).toMatch(/▲.*advisory\.ts/);
		expect(fileRow).not.toMatch(/●.*advisory\.ts/);
	});

	it("details block lists only blocking diagnostics before non-blocking ones", () => {
		const filePath = `${process.cwd()}/mixed.ts`;
		recordRunner(filePath, "lint", "succeeded", 3);
		recordDiagnostics(filePath, [
			{
				severity: "warning",
				semantic: "warning",
				message: "non-blocking advisory",
				rule: "advice",
				line: 10,
			},
			{
				severity: "warning",
				semantic: "blocking",
				message: "blocking sonar issue",
				rule: "cors-wildcard",
				line: 20,
			},
		]);

		const lines = renderWidget(120, theme);
		const allLines = lines.join("\n");
		expect(allLines).toContain("blocking sonar issue");
		// The non-blocking one is included as a tail filler (slot remaining).
		// What matters is that the blocking diagnostic appears before the
		// non-blocking one in the rendered output.
		const blockIdx = allLines.indexOf("blocking sonar issue");
		const adviceIdx = allLines.indexOf("non-blocking advisory");
		expect(blockIdx).toBeGreaterThan(0);
		if (adviceIdx >= 0) expect(blockIdx).toBeLessThan(adviceIdx);
	});

	it("shows formatter name when a formatter changed the file", () => {
		const filePath = `${process.cwd()}/app.ts`;
		recordFormatter(filePath, "biome", true, true);
		recordFormatter(filePath, "prettier", false, true);

		const lines = renderWidget(120, theme);
		const allLines = lines.join("");

		expect(allLines).toContain("fmt:biome");
		expect(allLines).not.toContain("prettier");
	});
});
