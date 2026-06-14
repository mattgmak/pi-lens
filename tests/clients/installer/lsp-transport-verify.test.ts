import { describe, expect, it } from "vitest";
import { isLspTransportRequiredError } from "../../../clients/installer/index.js";

/**
 * #208 — stdio LSP servers (the vscode-langservers-extracted family: json/css/
 * html/eslint, and markdown) reject a bare `--version` and exit non-zero, but
 * the error proves the binary is a valid LSP server. verifyToolBinary must
 * treat that as success; a genuinely broken install (different error) must
 * still fail.
 */
describe("isLspTransportRequiredError (#208)", () => {
	it("recognises the exact vscode-json-language-server transport error", () => {
		const out =
			"Error: Connection input stream is not set. Use arguments of createConnection or set command line parameters: '--node-ipc', '--stdio' or '--socket={number}'";
		expect(isLspTransportRequiredError(out)).toBe(true);
	});

	it("matches the createConnection guidance fragment alone", () => {
		expect(
			isLspTransportRequiredError("Use arguments of createConnection"),
		).toBe(true);
	});

	it("matches the output-stream variant and is case-insensitive", () => {
		expect(
			isLspTransportRequiredError("connection OUTPUT stream is not set"),
		).toBe(true);
	});

	it("does NOT match a genuinely broken install", () => {
		expect(
			isLspTransportRequiredError(
				"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vscode-languageserver'",
			),
		).toBe(false);
		expect(
			isLspTransportRequiredError("SyntaxError: Unexpected end of input"),
		).toBe(false);
		expect(isLspTransportRequiredError("")).toBe(false);
	});

	it("does NOT match an unrelated non-zero exit (e.g. unknown flag)", () => {
		expect(
			isLspTransportRequiredError("error: unknown option '--version'"),
		).toBe(false);
	});
});
