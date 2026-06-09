/**
 * Regression guards for the chunked-yield source collector and the
 * generated-header read memo (PERF-AUDIT.md).
 *
 * Two invariants are guarded here:
 *
 *   1. Correctness / no-detection-loss — `collectSourceFilesAsync` returns the
 *      EXACT same file set as the synchronous `collectSourceFiles`. The async
 *      variant exists purely to spread the walk across event-loop ticks; it
 *      must never change which files are kept.
 *
 *   2. Event-loop budget — on a multi-hundred-file tree the async walk yields
 *      often enough that no single synchronous chunk between yields exceeds the
 *      ~50ms typing-window budget. The previously-synchronous `collectSourceFiles`
 *      held the loop for ~1.5s on a 2k-file project; the async variant must not
 *      reintroduce a comparable burst.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetGeneratedArtifactCaches } from "../../clients/generated-artifacts.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
} from "../../clients/source-filter.js";

let tmpDir: string;

/** Build a nested tree of `target` source files plus ignored noise. */
function buildFixture(root: string, target: number): number {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(
		path.join(root, ".gitignore"),
		"node_modules/\ndist/\n*.log\nbuild/\n",
	);
	// .git marker so the gitignore root resolves to `root`.
	fs.writeFileSync(path.join(root, ".git"), "");
	const exts = [".ts", ".ts", ".js", ".py", ".tsx"];
	let made = 0;
	const mk = (dir: string, depth: number): void => {
		fs.mkdirSync(dir, { recursive: true });
		const here = depth >= 2 ? 6 : 3;
		for (let i = 0; i < here && made < target; i++) {
			const ext = exts[made % exts.length];
			fs.writeFileSync(
				path.join(dir, `file${i}${ext}`),
				`export const x${i} = ${i};\n`,
			);
			made++;
			// A shadowed .js next to a .ts must be filtered as a build artifact.
			if (ext === ".ts" && i % 2 === 0) {
				fs.writeFileSync(path.join(dir, `file${i}.js`), `var x=${i};`);
			}
		}
		if (depth < 4 && made < target) {
			for (let d = 0; d < 3 && made < target; d++) {
				mk(path.join(dir, `sub${d}`), depth + 1);
			}
		}
	};
	mk(path.join(root, "src"), 0);
	mk(path.join(root, "lib"), 0);
	// Ignored noise that must never appear in the result.
	const nm = path.join(root, "node_modules", "pkg");
	fs.mkdirSync(nm, { recursive: true });
	for (let i = 0; i < 50; i++)
		fs.writeFileSync(path.join(nm, `m${i}.js`), "module.exports=1");
	return made;
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sf-async-"));
	_resetGeneratedArtifactCaches();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	_resetGeneratedArtifactCaches();
});

describe("collectSourceFilesAsync — correctness", () => {
	it("returns the same file set as the synchronous collector", async () => {
		buildFixture(tmpDir, 200);
		const sync = collectSourceFiles(tmpDir);
		_resetGeneratedArtifactCaches();
		const async = await collectSourceFilesAsync(tmpDir);

		expect(async.length).toBe(sync.length);
		expect(new Set(async)).toEqual(new Set(sync));
	});

	it("filters build artifacts and ignored dirs identically", async () => {
		buildFixture(tmpDir, 120);
		const result = await collectSourceFilesAsync(tmpDir);
		// No shadowed .js (a .ts sibling exists), no node_modules.
		expect(result.some((f) => f.includes("node_modules"))).toBe(false);
		expect(
			result.some(
				(f) => f.endsWith(".js") && fs.existsSync(f.replace(/\.js$/, ".ts")),
			),
		).toBe(false);
	});

	it("respects the extensions option the same way as sync", async () => {
		buildFixture(tmpDir, 150);
		const opts = { extensions: [".py"] };
		const sync = collectSourceFiles(tmpDir, opts);
		_resetGeneratedArtifactCaches();
		const async = await collectSourceFilesAsync(tmpDir, opts);
		expect(new Set(async)).toEqual(new Set(sync));
		expect(async.every((f) => f.endsWith(".py"))).toBe(true);
	});
});

describe("collectSourceFilesAsync — event-loop budget", () => {
	// Budget guard: the longest synchronous stretch between yields must stay
	// well under pi's typing window. Generous ceiling so this is a regression
	// trip-wire (a 2× regression means something un-yielding crept back in),
	// not a flaky micro-benchmark.
	const MAX_SYNC_CHUNK_MS = 120;

	it("never blocks the loop longer than the budget between yields", async () => {
		buildFixture(tmpDir, 600);
		_resetGeneratedArtifactCaches(); // force cold header reads (worst case)

		let maxChunk = 0;
		let last = process.hrtime.bigint();
		const orig = global.setImmediate;
		// Wrap setImmediate to measure the synchronous gap between successive
		// yields performed by the collector.
		(global as { setImmediate: typeof setImmediate }).setImmediate = ((
			cb: () => void,
		) =>
			orig(() => {
				const now = process.hrtime.bigint();
				const d = Number(now - last) / 1e6;
				if (d > maxChunk) maxChunk = d;
				last = process.hrtime.bigint();
				cb();
			})) as unknown as typeof setImmediate;

		try {
			last = process.hrtime.bigint();
			const files = await collectSourceFilesAsync(tmpDir, { yieldEvery: 50 });
			expect(files.length).toBeGreaterThan(0);
		} finally {
			(global as { setImmediate: typeof setImmediate }).setImmediate = orig;
		}

		expect(maxChunk).toBeLessThan(MAX_SYNC_CHUNK_MS);
	});
});

describe("generated-header read memo", () => {
	it("reuses the header verdict on a repeat scan of unchanged files", async () => {
		buildFixture(tmpDir, 400);

		// Cold scan: every kept file pays the 4 KB header read.
		_resetGeneratedArtifactCaches();
		const c0 = process.hrtime.bigint();
		const first = collectSourceFiles(tmpDir);
		const coldMs = Number(process.hrtime.bigint() - c0) / 1e6;

		// Warm scan: same files, memo hit → stat replaces open+read+close.
		const w0 = process.hrtime.bigint();
		const second = collectSourceFiles(tmpDir);
		const warmMs = Number(process.hrtime.bigint() - w0) / 1e6;

		// Behavior is unchanged.
		expect(new Set(second)).toEqual(new Set(first));
		// The memo must make the repeat scan meaningfully cheaper. Loose factor
		// (the cold read dominates) so this is a trip-wire, not a flaky bench.
		expect(warmMs).toBeLessThan(coldMs * 0.85);
	});

	it("re-reads the header after a file is modified (memo self-invalidates)", async () => {
		buildFixture(tmpDir, 60);
		_resetGeneratedArtifactCaches();

		// First scan keeps a plain source file.
		const target = collectSourceFiles(tmpDir).find((f) => f.endsWith(".ts"));
		expect(target).toBeDefined();
		if (!target) return;
		expect(collectSourceFiles(tmpDir)).toContain(target);

		// Rewrite it with a generated banner + a fresh mtime. The memo key
		// includes mtime+size, so the new verdict (artifact) must take effect.
		await new Promise((r) => setTimeout(r, 12));
		fs.writeFileSync(
			target,
			`// @generated by codegen — do not edit\nexport const x = 1;\n`,
		);
		const after = collectSourceFiles(tmpDir);
		expect(after).not.toContain(target);
	});
});
