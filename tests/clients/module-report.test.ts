import { afterEach, describe, expect, it } from "vitest";
import {
	moduleReport,
	readSymbol,
} from "../../clients/module-report.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeEnv(prefix = "pi-lens-modreport-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

describe("moduleReport — outline depth (single-file, no graph)", () => {
	it("extracts a TypeScript outline with signatures, line ranges, and read args", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"sample.ts",
			[
				"export function add(a: number, b: number): number {",
				"  return a + b;",
				"}",
				"",
				"function helper(x: string) {",
				"  return x.trim();",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir, { depth: "outline" });

		expect(report.available).toBe(true);
		expect(report.language).toBe("jsts");
		expect(report.staleness).toBe("snapshot-only"); // outline = no cross-file graph

		const add = report.api.find((e) => e.name === "add");
		expect(add).toBeDefined();
		expect(add?.exported).toBe(true);
		expect(add?.kind).toBe("function");
		expect(add?.signature).toContain("a: number");
		// endLine must exceed startLine for a multi-line function (the Symbol.endLine
		// enabler) and drive the pre-computed read args.
		expect(add!.endLine).toBeGreaterThan(add!.startLine);
		expect(add!.read).toEqual({
			path: file,
			offset: add!.startLine,
			limit: add!.endLine - add!.startLine + 1,
		});

		// Non-exported symbol is routed to `internal`, not `api`.
		expect(report.internal.some((e) => e.name === "helper")).toBe(true);
		expect(report.api.some((e) => e.name === "helper")).toBe(false);
	});

	it("extracts a Python outline (language-uniform, not TS-only)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"sample.py",
			["def greet(name):", "    return f'hi {name}'", "", "class Greeter:", "    pass"].join(
				"\n",
			),
		);

		const report = await moduleReport(file, env.tmpDir, { depth: "outline" });

		expect(report.available).toBe(true);
		expect(report.language).toBe("python");
		const names = [...report.api, ...report.internal].map((e) => e.name);
		expect(names).toContain("greet");
		expect(names).toContain("Greeter");
	});

	it("extracts a .tsx file via the JSX-aware grammar (downloaded-grammar coverage)", async () => {
		const env = makeEnv();
		const file = createTempFile(
			env.tmpDir,
			"widget.tsx",
			[
				"export function Widget(props: { label: string }) {",
				"  return <div>{props.label}</div>;",
				"}",
			].join("\n"),
		);

		const report = await moduleReport(file, env.tmpDir, { depth: "outline" });

		expect(report.available).toBe(true);
		expect(report.api.some((e) => e.name === "Widget")).toBe(true);
	});

	it("returns available:false for a non-symbol-bearing file (json)", async () => {
		const env = makeEnv();
		const file = createTempFile(env.tmpDir, "data.json", '{"a": 1}\n');
		const report = await moduleReport(file, env.tmpDir, { depth: "outline" });
		expect(report.available).toBe(false);
		expect(report.staleness).toBe("unavailable");
		expect(report.api).toHaveLength(0);
	});

	it("returns an unavailable report for a missing file", async () => {
		const env = makeEnv();
		const report = await moduleReport("nope.ts", env.tmpDir, {
			depth: "outline",
		});
		expect(report.available).toBe(false);
		expect(report.staleness).toBe("unavailable");
	});
});

describe("moduleReport — standard depth (graph who-uses-this)", () => {
	it("resolves cross-file callers from the review graph", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo(x: number): number {\n  return x + 1;\n}\n",
		);
		createTempFile(
			env.tmpDir,
			"b.ts",
			[
				'import { foo } from "./a.js";',
				"export function callsFoo(): number {",
				"  return foo(41);",
				"}",
			].join("\n"),
		);

		const report = await moduleReport("a.ts", env.tmpDir, {
			depth: "standard",
		});

		expect(report.available).toBe(true);
		expect(report.staleness).toBe("fresh");
		const foo = report.api.find((e) => e.name === "foo");
		expect(foo).toBeDefined();
		expect(foo?.usedBy?.some((u) => u.file.endsWith("b.ts"))).toBe(true);
		// recommendedReads should surface the referenced, exported symbol.
		expect(report.recommendedReads.some((r) => r.symbol === "foo")).toBe(true);
	});

	it("populates imports for a non-jsts language (python) via graph import edges (#249)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"app.py",
			"import os\nimport requests\nfrom . import helper\n\ndef go():\n    return os.getcwd()\n",
		);
		createTempFile(env.tmpDir, "helper.py", "def h():\n    return 1\n");

		const report = await moduleReport("app.py", env.tmpDir, {
			depth: "standard",
		});

		expect(report.available).toBe(true);
		// External package imports come through the new tree-sitter import edges.
		expect(report.imports.external).toContain("os");
		expect(report.imports.external).toContain("requests");
		expect(report.summary.imports).toBeGreaterThan(0);
	});

	it("imports stay empty at outline depth (no graph) — but symbols still extract", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"app.py",
			"import os\n\ndef go():\n    return os.getcwd()\n",
		);
		const report = await moduleReport("app.py", env.tmpDir, {
			depth: "outline",
		});
		expect(report.imports.external).toHaveLength(0);
		expect([...report.api, ...report.internal].some((e) => e.name === "go")).toBe(
			true,
		);
	});
});

describe("readSymbol — verbatim body for guard-satisfying reads", () => {
	it("returns the exact source lines of a named symbol", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"sample.ts",
			[
				"const noise = 1;",
				"export function target(n: number): number {",
				"  const doubled = n * 2;",
				"  return doubled;",
				"}",
			].join("\n"),
		);

		const result = await readSymbol("sample.ts", "target", env.tmpDir);

		expect(result.found).toBe(true);
		expect(result.kind).toBe("function");
		expect(result.startLine).toBe(2);
		expect(result.endLine).toBe(5);
		expect(result.source).toContain("export function target");
		expect(result.source).toContain("return doubled;");
		// Must not leak lines outside the symbol body.
		expect(result.source).not.toContain("const noise");
	});

	it("reports not-found for an unknown symbol", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "sample.ts", "export const x = 1;\n");
		const result = await readSymbol("sample.ts", "ghost", env.tmpDir);
		expect(result.found).toBe(false);
	});
});
