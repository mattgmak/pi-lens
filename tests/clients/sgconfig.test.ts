import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetBaselineSgconfigForTests,
	resolveBaselineSgconfig,
} from "../../clients/sgconfig.js";

describe("ast-grep baseline sgconfig", () => {
	afterEach(() => {
		_resetBaselineSgconfigForTests();
	});

	it("includes pi-lens rules plus vendored CodeRabbit rules", () => {
		_resetBaselineSgconfigForTests();
		const configPath = resolveBaselineSgconfig();
		expect(configPath).toBeDefined();
		if (!configPath) throw new Error("expected baseline sgconfig");
		const text = fs.readFileSync(configPath, "utf8");
		const normalized = text.replace(/\\/g, "/");
		expect(normalized).toContain("/rules/ast-grep-rules/rules");
		expect(normalized).toContain("/rules/ast-grep-rules/coderabbit/rules");
	});

	it("writes absolute ruleDirs so the temp config works outside the package root", () => {
		_resetBaselineSgconfigForTests();
		const configPath = resolveBaselineSgconfig();
		expect(configPath).toBeDefined();
		if (!configPath) throw new Error("expected baseline sgconfig");
		const text = fs.readFileSync(configPath, "utf8");
		const ruleDirLines = text
			.split(/\r?\n/)
			.filter((line) => line.trim().startsWith("- "));
		expect(ruleDirLines.length).toBeGreaterThanOrEqual(2);
		for (const line of ruleDirLines) {
			const value = line.replace(/^\s*-\s*/, "").replace(/^"|"$/g, "");
			expect(path.isAbsolute(value)).toBe(true);
		}
	});

	it("uses a per-PROCESS filename embedding the pid (#472: the path doubles as the reaper's unique marker)", () => {
		_resetBaselineSgconfigForTests();
		const configPath = resolveBaselineSgconfig();
		expect(configPath).toBeDefined();
		if (!configPath) throw new Error("expected baseline sgconfig");
		expect(path.basename(configPath)).toBe(
			`baseline-${process.pid}.sgconfig.yml`,
		);
	});

	it("cleans up stale baseline configs (>7 days) but never the current file or unrelated files", () => {
		const dir = path.join(os.tmpdir(), "pi-lens-ast-grep");
		fs.mkdirSync(dir, { recursive: true });

		// Plant: a stale per-pid baseline, a stale legacy shared baseline, a
		// FRESH per-pid baseline (another live session), and an unrelated file.
		const staleOld = path.join(dir, "baseline-999991.sgconfig.yml");
		const staleLegacy = path.join(dir, "baseline.sgconfig.yml");
		const freshOther = path.join(dir, "baseline-999992.sgconfig.yml");
		const unrelated = path.join(dir, "unrelated-999993.yml");
		for (const f of [staleOld, staleLegacy, freshOther, unrelated]) {
			fs.writeFileSync(f, "ruleDirs: []\n");
		}
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(staleOld, eightDaysAgo, eightDaysAgo);
		fs.utimesSync(staleLegacy, eightDaysAgo, eightDaysAgo);
		fs.utimesSync(unrelated, eightDaysAgo, eightDaysAgo);
		// freshOther keeps its current mtime — must survive.

		try {
			_resetBaselineSgconfigForTests();
			const configPath = resolveBaselineSgconfig();
			expect(configPath).toBeDefined();
			if (!configPath) throw new Error("expected baseline sgconfig");

			expect(fs.existsSync(staleOld)).toBe(false); // old per-pid ⇒ removed
			expect(fs.existsSync(staleLegacy)).toBe(false); // old legacy shared ⇒ removed
			expect(fs.existsSync(freshOther)).toBe(true); // recent sibling ⇒ kept
			expect(fs.existsSync(unrelated)).toBe(true); // non-baseline name ⇒ kept
			expect(fs.existsSync(configPath)).toBe(true); // current file ⇒ kept
		} finally {
			for (const f of [freshOther, unrelated]) {
				fs.rmSync(f, { force: true });
			}
		}
	});
});
