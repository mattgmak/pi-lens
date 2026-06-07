import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractReadPathsFromCommand, type ReadSpan } from "../../index.js";

let tmp: string;

/** Write a file with `lines` newline-separated lines; returns its absolute path. */
function touchLines(name: string, lines = 1): string {
	const p = path.join(tmp, name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(
		p,
		Array.from({ length: lines }, (_, i) => `line${i + 1}`).join("\n"),
	);
	return p;
}

function spanFor(result: ReadSpan[], file: string): ReadSpan | undefined {
	return result.find((s) => s.filePath === file);
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ercmd-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

// ── full-file viewers ───────────────────────────────────────────────────────

describe("full-file view commands", () => {
	it("cat FILE registers the whole file", () => {
		const f = touchLines("a.ts", 5);
		const s = spanFor(extractReadPathsFromCommand(`cat ${f}`, tmp), f);
		expect(s).toEqual({ filePath: f, offset: 1, limit: 5 });
	});

	it("less / more / bat / nl also register full reads", () => {
		const f = touchLines("a.ts", 3);
		for (const verb of ["less", "more", "bat", "nl"]) {
			const s = spanFor(extractReadPathsFromCommand(`${verb} ${f}`, tmp), f);
			expect(s, verb).toEqual({ filePath: f, offset: 1, limit: 3 });
		}
	});

	it("resolves a relative path against cwd", () => {
		const f = touchLines("sub/b.ts", 2);
		const rel = path.relative(tmp, f);
		const s = spanFor(extractReadPathsFromCommand(`cat ${rel}`, tmp), f);
		expect(s).toEqual({ filePath: f, offset: 1, limit: 2 });
	});

	it("registers each file across && / ; segments", () => {
		const a = touchLines("a.ts", 4);
		const b = touchLines("b.ts", 6);
		const r = extractReadPathsFromCommand(`cat ${a} && cat ${b}`, tmp);
		expect(spanFor(r, a)).toEqual({ filePath: a, offset: 1, limit: 4 });
		expect(spanFor(r, b)).toEqual({ filePath: b, offset: 1, limit: 6 });
	});

	it("deduplicates the same file+range mentioned twice", () => {
		const f = touchLines("a.ts", 3);
		const r = extractReadPathsFromCommand(`cat ${f} ; cat ${f}`, tmp);
		expect(r.filter((s) => s.filePath === f)).toHaveLength(1);
	});
});

// ── partial viewers register the EXACT range shown ──────────────────────────

describe("partial view commands register the shown range only", () => {
	it("head -n N → lines 1..N", () => {
		const f = touchLines("a.ts", 100);
		expect(
			spanFor(extractReadPathsFromCommand(`head -n 20 ${f}`, tmp), f),
		).toEqual({ filePath: f, offset: 1, limit: 20 });
	});

	it("head -N shorthand → lines 1..N", () => {
		const f = touchLines("a.ts", 100);
		expect(spanFor(extractReadPathsFromCommand(`head -20 ${f}`, tmp), f)).toEqual({
			filePath: f,
			offset: 1,
			limit: 20,
		});
	});

	it("head clamps when N exceeds the file length", () => {
		const f = touchLines("a.ts", 5);
		expect(spanFor(extractReadPathsFromCommand(`head -20 ${f}`, tmp), f)).toEqual({
			filePath: f,
			offset: 1,
			limit: 5,
		});
	});

	it("tail -n N → the LAST N lines", () => {
		const f = touchLines("a.ts", 100);
		expect(
			spanFor(extractReadPathsFromCommand(`tail -n 10 ${f}`, tmp), f),
		).toEqual({ filePath: f, offset: 91, limit: 10 });
	});

	it("sed -n 'A,Bp' → lines A..B", () => {
		const f = touchLines("a.ts", 100);
		expect(
			spanFor(extractReadPathsFromCommand(`sed -n '2,40p' ${f}`, tmp), f),
		).toEqual({ filePath: f, offset: 2, limit: 39 });
	});
});

// ── safety: writes / non-reads must NOT be registered ───────────────────────

describe("writes and non-content commands are NOT registered (guard safety)", () => {
	const cases: Array<[string, (f: string) => string]> = [
		["echo redirect (>)", (f) => `echo "x" > ${f}`],
		["append redirect (>>)", (f) => `echo "x" >> ${f}`],
		["sed -i (in-place edit)", (f) => `sed -i 's/a/b/' ${f}`],
		["tee", (f) => `echo x | tee ${f}`],
		["cp destination", (f) => `cp /other/src.ts ${f}`],
		["mv destination", (f) => `mv /other/src.ts ${f}`],
		["ls (no content)", (f) => `ls -l ${f}`],
		["grep (scattered matches)", (f) => `grep -n "foo" ${f}`],
		["find (names only)", (f) => `find . -name ${path.basename(f)}`],
		["bare mention in unrelated cmd", (f) => `echo building ${f} now`],
	];

	for (const [label, build] of cases) {
		it(`${label} does not register a read`, () => {
			const f = touchLines("a.ts", 5);
			const r = extractReadPathsFromCommand(build(f), tmp);
			expect(spanFor(r, f)).toBeUndefined();
		});
	}
});

// ── edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
	it("non-existent file yields no span", () => {
		expect(
			extractReadPathsFromCommand(`cat /does/not/exist.ts`, tmp),
		).toHaveLength(0);
	});

	it("directory argument is rejected", () => {
		expect(extractReadPathsFromCommand(`cat ${tmp}`, tmp)).toHaveLength(0);
	});

	it("unsupported extension is not registered", () => {
		const f = touchLines("package.lock", 3);
		expect(
			spanFor(extractReadPathsFromCommand(`cat ${f}`, tmp), f),
		).toBeUndefined();
	});

	it("empty / fileless commands return []", () => {
		expect(extractReadPathsFromCommand("", tmp)).toHaveLength(0);
		expect(extractReadPathsFromCommand("echo hello world", tmp)).toHaveLength(0);
	});

	it("does not throw on paths with spaces (unsupported, must not crash)", () => {
		expect(() =>
			extractReadPathsFromCommand(`cat '/tmp/my file.ts'`, tmp),
		).not.toThrow();
	});
});
