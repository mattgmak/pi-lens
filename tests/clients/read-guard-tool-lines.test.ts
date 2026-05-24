import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	countFileLines,
	getTouchedLinesForGuard,
	tryCorrectIndentationMismatch,
} from "../../clients/read-guard-tool-lines.ts";
import { logReadGuardEvent } from "../../clients/read-guard-logger.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/read-guard-logger.js", () => ({
	logReadGuardEvent: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(logReadGuardEvent).mockClear();
});

describe("read-guard tool line helpers", () => {
	it("returns undefined touchedLines for text-replacement edits without explicit ranges and no filePath", () => {
		const event = {
			toolName: "edit",
			input: {
				path: "/src/file.ts",
				edits: [{ oldText: "foo", newText: "bar" }],
			},
		};

		expect(getTouchedLinesForGuard(event).touchedLines).toBeUndefined();
	});

	it("uses only edits that actually provide ranges", () => {
		const event = {
			toolName: "edit",
			input: {
				path: "/src/file.ts",
				edits: [
					{ oldText: "foo", newText: "bar" },
					{
						range: {
							start: { line: 10 },
							end: { line: 12 },
						},
					},
				],
			},
		};

		expect(getTouchedLinesForGuard(event).touchedLines).toEqual([10, 12]);
	});

	it("parses hashline set_line anchors", () => {
		const event = {
			toolName: "edit",
			input: {
				set_line: { anchor: "45:4bf", new_text: "updated" },
			},
		};

		const result = getTouchedLinesForGuard(event, "/src/file.ts");
		expect(result.touchedLines).toEqual([45, 45]);
		expect(result.editRanges).toBeUndefined();
		expect(result.preflightError).toBeUndefined();
	});

	it("parses hashline replace_lines anchors", () => {
		const event = {
			toolName: "edit",
			input: {
				replace_lines: {
					start_anchor: "45:4bf",
					end_anchor: "48:abc",
					new_text: "updated",
				},
			},
		};

		const result = getTouchedLinesForGuard(event, "/src/file.ts");
		expect(result.touchedLines).toEqual([45, 48]);
		expect(result.editRanges).toBeUndefined();
		expect(result.preflightError).toBeUndefined();
	});

	it("parses batched hashline operations with editRanges", () => {
		const event = {
			toolName: "edit",
			input: {
				operations: [
					{ set_line: { anchor: "4:a", new_text: "a" } },
					{
						replace_lines: {
							start_anchor: "10:b",
							end_anchor: "12:c",
							new_text: "b",
						},
					},
				],
			},
		};

		const result = getTouchedLinesForGuard(event, "/src/file.ts");
		expect(result.touchedLines).toEqual([4, 12]);
		expect(result.editRanges).toEqual([
			[4, 4],
			[10, 12],
		]);
		expect(result.preflightError).toBeUndefined();
	});

	it("returns preflightError for malformed hashline anchors", () => {
		const event = {
			toolName: "edit",
			input: {
				set_line: { anchor: "line-45", new_text: "updated" },
			},
		};

		const result = getTouchedLinesForGuard(event, "/src/file.ts");
		expect(result.touchedLines).toBeUndefined();
		expect(result.preflightError).toMatch(/Unsupported hashline edit target/);
		expect(result.preflightError).toMatch(/malformed/);
	});

	it("returns preflightError for inverted hashline ranges", () => {
		const event = {
			toolName: "edit",
			input: {
				replace_lines: {
					start_anchor: "50:a",
					end_anchor: "45:b",
					new_text: "updated",
				},
			},
		};

		const result = getTouchedLinesForGuard(event, "/src/file.ts");
		expect(result.touchedLines).toBeUndefined();
		expect(result.preflightError).toMatch(/inverted/);
	});

	it("returns preflightError for hashline replace_symbol until symbol resolution exists", () => {
		const event = {
			toolName: "edit",
			input: {
				replace_symbol: { symbol: "add", new_body: "return a + b;" },
			},
		};

		const result = getTouchedLinesForGuard(event, "/src/file.ts");
		expect(result.touchedLines).toBeUndefined();
		expect(result.preflightError).toMatch(/replace_symbol/);
		expect(result.preflightError).toMatch(/line anchors/);
	});

	it("logs unknown edit schemas as missing touched-line telemetry", () => {
		const event = {
			toolName: "edit",
			input: {
				path: "/src/file.ts",
				custom_patch: { line: 1, value: "x" },
			},
		};

		const result = getTouchedLinesForGuard(event, "/src/file.ts");
		expect(result.touchedLines).toBeUndefined();
		expect(result.preflightError).toBeUndefined();
	});

	it("uses actual on-disk line count for writes", () => {
		const env = setupTestEnvironment("read-guard-lines-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\n");

			expect(countFileLines(filePath)).toBe(4);
			expect(
				getTouchedLinesForGuard(
					{ toolName: "write", input: { path: filePath } },
					filePath,
				).touchedLines,
			).toEqual([1, 4]);
		} finally {
			env.cleanup();
		}
	});

	it("resolves unique oldText to a line range", () => {
		const env = setupTestEnvironment("read-guard-lines-resolve-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{
							oldText: "function bar() {\n  return 2;\n}",
							newText: "function bar() {\n  return 99;\n}",
						},
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toEqual([5, 7]);
			expect(result.editRanges).toBeUndefined();
			expect(result.preflightError).toBeUndefined();
			expect(result.contentMatchValidated).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("returns editRanges for multiple resolved oldText edits", () => {
		const env = setupTestEnvironment("read-guard-lines-multi-oldtext-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{ oldText: "return 1;", newText: "return 10;" },
						{ oldText: "return 2;", newText: "return 20;" },
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toEqual([2, 6]);
			expect(result.editRanges).toEqual([
				[2, 2],
				[6, 6],
			]);
			expect(result.preflightError).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("includes resolved oldText ranges in mixed range + oldText edits", () => {
		const env = setupTestEnvironment("read-guard-lines-mixed-ranges-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{
							range: { start: { line: 1 }, end: { line: 1 } },
							newText: "function fooRenamed() {",
						},
						{ oldText: "return 2;", newText: "return 20;" },
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toEqual([1, 6]);
			expect(result.editRanges).toEqual([
				[1, 1],
				[6, 6],
			]);
			expect(result.preflightError).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("returns preflightError with line numbers when oldText appears multiple times", () => {
		const env = setupTestEnvironment("read-guard-lines-dup-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"  return value;\n}\n\nfunction b() {\n  return value;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [{ oldText: "  return value;", newText: "  return 42;" }],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toBeUndefined();
			expect(result.preflightError).toMatch(/RETRYABLE/);
			expect(result.preflightError).toMatch(/edits\[0\]/);
			expect(result.preflightError).toMatch(/2 times/);
			expect(result.preflightError).toMatch(/Line 1/);
			expect(result.preflightError).toMatch(/Line 5/);
			expect(logReadGuardEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: "edit_preflight_blocked",
					filePath,
					metadata: expect.objectContaining({
						reasonKind: "oldtext_duplicate",
						failedEditIndexes: [0],
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("returns preflightError when oldText is not found", () => {
		const env = setupTestEnvironment("read-guard-lines-missing-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n  return 1;\n}\n");

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{ oldText: "function bar() {\n  return 2;\n}", newText: "noop" },
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toBeUndefined();
			expect(result.preflightError).toMatch(/RETRYABLE/);
			expect(result.preflightError).toMatch(/was not found/);
			expect(result.preflightError).toMatch(/Re-read the relevant section/);
			expect(logReadGuardEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: "edit_preflight_blocked",
					filePath,
					metadata: expect.objectContaining({
						reasonKind: "oldtext_not_found",
						failedEditIndexes: [0],
						oldTextPreviews: ["function bar() {↵  return 2;↵}"],
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("returns preflightError when only some edits resolve", () => {
		const env = setupTestEnvironment("read-guard-lines-partial-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{ oldText: "function bar() {\n  return 2;\n}", newText: "ok" },
						{ oldText: "function baz() {\n  return 3;\n}", newText: "missing" },
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toBeUndefined();
			expect(result.preflightError).toMatch(/RETRYABLE/);
			expect(result.preflightError).toMatch(/edits\[1\]/);
			expect(result.preflightError).toMatch(/was not found/);
		} finally {
			env.cleanup();
		}
	});

	it("blocks mixed range + oldText edits when an oldText target is unresolved", () => {
		const env = setupTestEnvironment("read-guard-lines-mixed-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{
							range: { start: { line: 1 }, end: { line: 1 } },
							newText: "function fooRenamed() {",
						},
						{ oldText: "function baz() {\n  return 3;\n}", newText: "missing" },
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toBeUndefined();
			expect(result.preflightError).toMatch(/RETRYABLE/);
			expect(result.preflightError).toMatch(/edits\[1\]/);
			expect(result.preflightError).toMatch(/was not found/);
		} finally {
			env.cleanup();
		}
	});
});

describe("tryCorrectIndentationMismatch", () => {
	it("returns undefined when oldText already matches the file", () => {
		const env = setupTestEnvironment("pi-lens-indent-match-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");
			expect(
				tryCorrectIndentationMismatch(
					"function foo() {\n\treturn 1;\n}",
					filePath,
				),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("corrects 4-space indentation to tabs when file uses tabs", () => {
		const env = setupTestEnvironment("pi-lens-indent-4to-tab-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");
			const result = tryCorrectIndentationMismatch(
				"function foo() {\n    return 1;\n}",
				filePath,
			);
			expect(result).toBe("function foo() {\n\treturn 1;\n}");
		} finally {
			env.cleanup();
		}
	});

	it("corrects 2-space indentation to tabs when file uses tabs", () => {
		const env = setupTestEnvironment("pi-lens-indent-2to-tab-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");
			const result = tryCorrectIndentationMismatch(
				"function foo() {\n  return 1;\n}",
				filePath,
			);
			expect(result).toBe("function foo() {\n\treturn 1;\n}");
		} finally {
			env.cleanup();
		}
	});

	it("corrects tabs to 4-space indentation when file uses 4 spaces", () => {
		const env = setupTestEnvironment("pi-lens-indent-tab-to-4-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n    return 1;\n}\n");
			const result = tryCorrectIndentationMismatch(
				"function foo() {\n\treturn 1;\n}",
				filePath,
			);
			expect(result).toBe("function foo() {\n    return 1;\n}");
		} finally {
			env.cleanup();
		}
	});

	it("corrects tabs to 2-space indentation when file uses 2 spaces", () => {
		const env = setupTestEnvironment("pi-lens-indent-tab-to-2-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n  return 1;\n}\n");
			const result = tryCorrectIndentationMismatch(
				"function foo() {\n\treturn 1;\n}",
				filePath,
			);
			expect(result).toBe("function foo() {\n  return 1;\n}");
		} finally {
			env.cleanup();
		}
	});

	it("corrects mixed-width space indentation to the exact tabbed file slice", () => {
		const env = setupTestEnvironment("pi-lens-indent-mixed-to-tab-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			const actual =
				"const group = {\n" +
				"\t\tresults: items.map((r) => ({\n" +
				"\t\t\ttitle: r.title,\n" +
				"\t\t})),\n" +
				"};\n";
			fs.writeFileSync(filePath, actual);

			const result = tryCorrectIndentationMismatch(
				"  results: items.map((r) => ({\n      title: r.title,\n  })),",
				filePath,
			);
			expect(result).toBe(
				"\t\tresults: items.map((r) => ({\n\t\t\ttitle: r.title,\n\t\t})),",
			);
		} finally {
			env.cleanup();
		}
	});

	it("resolves oldText line ranges after indentation correction", () => {
		const env = setupTestEnvironment("pi-lens-indent-resolve-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"const group = {\n\t\tresults: items.map((r) => ({\n\t\t\ttitle: r.title,\n\t\t})),\n};\n",
			);

			const result = getTouchedLinesForGuard(
				{
					toolName: "edit",
					input: {
						edits: [
							{
								oldText:
									"  results: items.map((r) => ({\n      title: r.title,\n  })),",
								newText:
									"\t\tresults: items.map((r) => ({\n\t\t\ttitle: r.name,\n\t\t})),",
							},
						],
					},
				},
				filePath,
			);

			expect(result.preflightError).toBeUndefined();
			expect(result.touchedLines).toEqual([2, 4]);
		} finally {
			env.cleanup();
		}
	});

	it("returns undefined when no indentation conversion fixes the mismatch", () => {
		const env = setupTestEnvironment("pi-lens-indent-no-fix-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");
			expect(
				tryCorrectIndentationMismatch(
					"function bar() {\n\treturn 2;\n}",
					filePath,
				),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
