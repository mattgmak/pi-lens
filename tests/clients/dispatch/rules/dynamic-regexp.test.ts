import { describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { dynamicRegexpRule } from "../../../../clients/dispatch/rules/sonar-rules.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import type { FileKind } from "../../../../clients/file-kinds.js";

function makeCtx(filePath: string, facts: FactStore): DispatchContext {
	return {
		filePath,
		cwd: "/tmp",
		kind: "jsts" as FileKind,
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
		hasTool: async () => false,
		log: () => {},
	};
}

function runRule(content: string) {
	const filePath = "/tmp/regex.ts";
	const facts = new FactStore();
	const ctx = makeCtx(filePath, facts);
	facts.setFileFact(filePath, "file.content", content);
	return dynamicRegexpRule.evaluate(ctx, facts);
}

describe("dynamicRegexpRule", () => {
	it("flags unescaped dynamic RegExp arguments", () => {
		expect(runRule("const r = new RegExp(userInput, 'i');\n")).toHaveLength(1);
	});

	it("does not flag directly escaped dynamic input", () => {
		expect(
			runRule("const r = new RegExp(escapeRegExp(userInput), 'i');\n"),
		).toHaveLength(0);
	});

	it("does not flag variables initialized from escaped template spans", () => {
		const diagnostics = runRule(
			[
				"function escapeRegExp(value: string): string {",
				'\treturn value.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&");',
				"}",
				"const pattern = `\\\\b${escapeRegExp(baseSymbol)}\\\\b`;",
				'const exactRegex = new RegExp(pattern, "g");',
				'const insensitiveRegex = new RegExp(pattern, "gi");',
			].join("\n"),
		);
		expect(diagnostics).toHaveLength(0);
	});

	it("still flags variables initialized from unescaped template spans", () => {
		const diagnostics = runRule(
			[
				"const pattern = `\\\\b${baseSymbol}\\\\b`;",
				'const regex = new RegExp(pattern, "g");',
			].join("\n"),
		);
		expect(diagnostics).toHaveLength(1);
	});

	it("does not use an outer safe variable when a parameter shadows it", () => {
		const diagnostics = runRule(`
const pattern = escapeRegExp(userInput);
function build(pattern: string) {
	return new RegExp(pattern);
}
`);
		expect(diagnostics).toHaveLength(1);
	});
});
