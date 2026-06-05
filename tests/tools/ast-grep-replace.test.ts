import { describe, expect, it, vi } from "vitest";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";

function makeClient(overrides: Partial<Parameters<typeof createAstGrepReplaceTool>[0]> = {}) {
	return {
		ensureAvailable: async () => true,
		replace: vi.fn().mockResolvedValue({ matches: [] }),
		replaceWithRule: vi.fn().mockResolvedValue({ matches: [], totalMatches: 0, applied: false }),
		formatMatches: () => "",
		...overrides,
	} as Parameters<typeof createAstGrepReplaceTool>[0];
}

describe("ast_grep_replace tool", () => {
	describe("schema shape", () => {
		it("lang uses enum not anyOf/const so LLMs do not double-quote it", () => {
			const tool = createAstGrepReplaceTool(makeClient());
			const langSchema = (tool.parameters as { properties: Record<string, unknown> }).properties.lang as Record<string, unknown>;
			expect(langSchema.type).toBe("string");
			expect(Array.isArray(langSchema.enum)).toBe(true);
			expect(langSchema.anyOf).toBeUndefined();
			expect(langSchema.const).toBeUndefined();
		});

		it("lang enum includes common languages", () => {
			const tool = createAstGrepReplaceTool(makeClient());
			const langSchema = (tool.parameters as { properties: Record<string, unknown> }).properties.lang as { enum: string[] };
			expect(langSchema.enum).toContain("typescript");
			expect(langSchema.enum).toContain("python");
			expect(langSchema.enum).toContain("rust");
		});
	});

	describe("lang double-quote stripping", () => {
		it("handles LLM-over-quoted lang like '\"typescript\"'", async () => {
			const replace = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepReplaceTool(makeClient({ replace }));
			await tool.execute(
				"1",
				{ pattern: "var $X", rewrite: "let $X", lang: '"typescript"' },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replace).toHaveBeenCalledWith(
				"var $X",
				"let $X",
				"typescript",
				expect.anything(),
				expect.anything(),
				expect.anything(),
			);
		});

		it("passes unquoted lang through unchanged", async () => {
			const replace = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepReplaceTool(makeClient({ replace }));
			await tool.execute(
				"2",
				{ pattern: "var $X", rewrite: "let $X", lang: "javascript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replace).toHaveBeenCalledWith(
				"var $X",
				"let $X",
				"javascript",
				expect.anything(),
				expect.anything(),
				expect.anything(),
			);
		});
	});

	it("dry-runs by default (apply not passed)", async () => {
		const replace = vi.fn().mockResolvedValue({ matches: [] });
		const tool = createAstGrepReplaceTool(makeClient({ replace }));
		await tool.execute(
			"3",
			{ pattern: "var $X", rewrite: "let $X", lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		expect(replace).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			false,
			expect.anything(),
		);
	});

	describe("structural-intent parameters (Phase 3)", () => {
		it("routes to replaceWithRule when insideKind is set", async () => {
			const replaceWithRule = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0, applied: false });
			const replace = vi.fn();
			const tool = createAstGrepReplaceTool(makeClient({ replaceWithRule, replace }));
			await tool.execute(
				"r1",
				{ pattern: "var $X", rewrite: "let $X", lang: "typescript", insideKind: "function_declaration" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replaceWithRule).toHaveBeenCalledOnce();
			expect(replace).not.toHaveBeenCalled();
		});

		it("synthesized YAML includes fix field", async () => {
			const replaceWithRule = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0, applied: false });
			const tool = createAstGrepReplaceTool(makeClient({ replaceWithRule }));
			await tool.execute(
				"r2",
				{ pattern: "var $X", rewrite: "let $X", lang: "javascript", insideKind: "function_declaration" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			const calledYaml = replaceWithRule.mock.calls[0][0] as string;
			expect(calledYaml).toContain("fix:");
			expect(calledYaml).toContain("let $X");
			expect(calledYaml).toContain("inside:");
		});

		it("routes to normal replace when no structural params", async () => {
			const replaceWithRule = vi.fn();
			const replace = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepReplaceTool(makeClient({ replaceWithRule, replace }));
			await tool.execute(
				"r3",
				{ pattern: "var $X", rewrite: "let $X", lang: "typescript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replace).toHaveBeenCalledOnce();
			expect(replaceWithRule).not.toHaveBeenCalled();
		});
	});

	it("applies changes when apply=true", async () => {
		const replace = vi.fn().mockResolvedValue({ matches: [] });
		const tool = createAstGrepReplaceTool(makeClient({ replace }));
		await tool.execute(
			"4",
			{ pattern: "var $X", rewrite: "let $X", lang: "typescript", apply: true },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		expect(replace).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true,
			expect.anything(),
		);
	});
});
