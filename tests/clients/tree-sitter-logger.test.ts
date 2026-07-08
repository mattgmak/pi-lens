import { afterEach, describe, expect, it, vi } from "vitest";

// Allow this test to exercise the real logger (it mocks fs, so no disk I/O).
process.env.PI_LENS_TEST_MODE = "0";

describe("tree-sitter-logger", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:os");
	});

	it("writes JSON line entries to tree-sitter.log", async () => {
		const appendFile = vi.fn(async (_file: string, _data: string) => {});

		vi.doMock("node:fs", () => ({
			mkdirSync: vi.fn(),
			statSync: () => {
				throw new Error("ENOENT");
			},
			promises: { appendFile },
		}));
		vi.doMock("node:os", () => ({
			homedir: () => "/mock-home",
		}));

		const mod = await import("../../clients/tree-sitter-logger.js");
		mod.logTreeSitter({
			phase: "runner_complete",
			filePath: "src/main.go",
			status: "succeeded",
			diagnostics: 2,
			blocking: 1,
		});

		// Buffered async write — await the exported flush before asserting.
		await mod.flushTreeSitterLog();

		expect(appendFile).toHaveBeenCalledTimes(1);
		const [filePath, payload] = appendFile.mock.calls[0];
		expect(filePath).toContain("tree-sitter.log");
		expect(payload).toContain('"phase":"runner_complete"');
		expect(payload).toContain('"filePath":"src/main.go"');
		expect(payload.endsWith("\n")).toBe(true);
		expect(mod.getTreeSitterLogPath()).toContain("tree-sitter.log");
	});

	it("swallows append errors", async () => {
		const appendFile = vi.fn(async () => {
			throw new Error("disk full");
		});

		vi.doMock("node:fs", () => ({
			mkdirSync: vi.fn(),
			statSync: () => {
				throw new Error("ENOENT");
			},
			promises: { appendFile },
		}));
		vi.doMock("node:os", () => ({
			homedir: () => "/mock-home",
		}));

		const mod = await import("../../clients/tree-sitter-logger.js");
		mod.logTreeSitter({ phase: "runner_start", filePath: "src/a.go" });
		// The swallowed rejection must not surface through flush().
		await expect(mod.flushTreeSitterLog()).resolves.toBeUndefined();
	});
});
