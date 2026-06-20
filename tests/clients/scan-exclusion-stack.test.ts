/**
 * #262 — every file-walker must respect the full exclusion stack.
 *
 * Table-driven guard: one fixture project carrying a default dependency dir
 * (node_modules), a build dir (dist), a `.gitignore` entry, a `.pi-lens.json`
 * `ignore` entry (both a glob and a bare filename), a real source file, and a
 * test file. Each major scan surface is asserted against the same fixture so a
 * regression in ANY surface (one that stops routing through the shared
 * exclusion helpers) fails here.
 *
 * Surfaces covered:
 *   - collectSourceFiles            (the canonical collector; no role filter)
 *   - TreeSitterClient.collectFiles (structural search walk; no role filter)
 *   - production-readiness source   (role-filtered: tests excluded)
 *   - production-readiness tests    (role-filtered: returns only tests)
 *
 * Global-ignore precedence is exercised indirectly (getProjectIgnoreMatcher
 * merges global + .gitignore + .pi-lens.json); we assert the project-config
 * layers here to keep the fixture hermetic.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __readinessWalkersForTest } from "../../clients/production-readiness.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { collectSourceFiles } from "../../clients/source-filter.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";

let tmpDir: string;

function write(rel: string, body = "export const x = 1;\n"): void {
	const full = path.join(tmpDir, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, body);
}

function relUnix(files: string[]): string[] {
	return files.map((f) => path.relative(tmpDir, f).replace(/\\/g, "/"));
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scan-exclude-"));
	resetProjectLensConfigCache();

	// The fixture every surface scans.
	write("src/real.ts");
	write("src/real.test.ts");
	write("node_modules/dep/index.ts");
	write("dist/out.ts");
	write("gitignored/x.ts");
	write("lensignored/y.ts");
	write("noise.ts");
	fs.writeFileSync(path.join(tmpDir, ".gitignore"), "gitignored/\n");
	fs.writeFileSync(
		path.join(tmpDir, ".pi-lens.json"),
		JSON.stringify({ ignore: ["lensignored/**", "noise.ts"] }),
	);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	resetProjectLensConfigCache();
});

// Paths that NO compliant surface may ever emit.
const ALWAYS_EXCLUDED = [
	"node_modules/",
	"dist/",
	"gitignored/",
	"lensignored/",
	"noise.ts",
];

interface Surface {
	name: string;
	collect: () => string[];
	mustInclude: string;
	/** Whether this surface applies the test/generated role filter. */
	excludesTests: boolean;
}

function surfaces(): Surface[] {
	return [
		{
			name: "collectSourceFiles (canonical collector)",
			collect: () => collectSourceFiles(tmpDir),
			mustInclude: "src/real.ts",
			excludesTests: false,
		},
		{
			name: "TreeSitterClient.collectFiles (structural search)",
			collect: () =>
				// collectFiles is private; the walk needs no grammars loaded.
				// biome-ignore lint/suspicious/noExplicitAny: private method under test
				(new TreeSitterClient() as any).collectFiles(tmpDir, "typescript"),
			mustInclude: "src/real.ts",
			excludesTests: false,
		},
		{
			name: "production-readiness findSourceFiles (role-filtered)",
			collect: () => __readinessWalkersForTest.findSourceFiles(tmpDir),
			mustInclude: "src/real.ts",
			excludesTests: true,
		},
	];
}

describe("#262 — exclusion stack is respected by every scan surface", () => {
	for (const s of surfaces()) {
		describe(s.name, () => {
			it("includes the real source file", () => {
				expect(relUnix(s.collect())).toContain(s.mustInclude);
			});

			it("excludes dependency/build dirs + .gitignore + .pi-lens.json ignores", () => {
				const rel = relUnix(s.collect());
				for (const excluded of ALWAYS_EXCLUDED) {
					expect(
						rel.some((f) => f === excluded || f.startsWith(excluded)),
						`${s.name} must exclude ${excluded}, got: ${rel.join(", ")}`,
					).toBe(false);
				}
			});

			it(
				s.excludesTests
					? "excludes test files (role filter)"
					: "retains test files (no role filter by design)",
				() => {
					const rel = relUnix(s.collect());
					expect(rel.includes("src/real.test.ts")).toBe(!s.excludesTests);
				},
			);
		});
	}

	describe("production-readiness findTestFiles (role-filtered, tests-only)", () => {
		it("returns the test file and still honors all exclusions", () => {
			const rel = relUnix(__readinessWalkersForTest.findTestFiles(tmpDir));
			expect(rel).toContain("src/real.test.ts");
			expect(rel).not.toContain("src/real.ts");
			for (const excluded of ALWAYS_EXCLUDED) {
				expect(rel.some((f) => f === excluded || f.startsWith(excluded))).toBe(
					false,
				);
			}
		});
	});

	it("isTestFile catches Go/Java/Python test-naming styles the role classifier alone misses", () => {
		const { isTestFile } = __readinessWalkersForTest;
		expect(isTestFile("/p/foo_test.go")).toBe(true);
		expect(isTestFile("/p/FooTest.java")).toBe(true);
		expect(isTestFile("/p/foo.test.ts")).toBe(true);
		expect(isTestFile("/p/src/real.ts")).toBe(false);
	});
});
