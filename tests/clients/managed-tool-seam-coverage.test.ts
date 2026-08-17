import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const CLIENTS = path.resolve("clients");
const ENSURE_WRAPPERS = new Set([
	"dispatch/runners/utils/runner-helpers.ts",
	"formatters.ts",
	"installer/index.ts",
	"lsp/server.ts",
	"mcp/session.ts",
	"runtime-session.ts",
	"security-scan-client.ts",
]);
const MANAGED_COMMANDS = new Set([
	"ast-grep",
	"biome",
	"jscpd",
	"knip",
	"madge",
	"ruff",
	"sg",
]);

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory()
			? sourceFiles(full)
			: entry.isFile() && entry.name.endsWith(".ts")
				? [full]
				: [];
	});
}

describe("managed-tool client seam coverage (#1290)", () => {
	it("keeps ensureTool and bare managed-tool spawns behind shared wrappers", () => {
		const violations: string[] = [];
		for (const file of sourceFiles(CLIENTS)) {
			const relative = path.relative(CLIENTS, file).split(path.sep).join("/");
			const source = fs
				.readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|\s)\/\/.*$/gm, "$1");
			if (!ENSURE_WRAPPERS.has(relative) && /\bensureTool\s*\(/.test(source)) {
				violations.push(`${relative}: direct ensureTool()`);
			}
			for (const match of source.matchAll(
				/\bsafeSpawnAsync\s*\(\s*["']([^"']+)["']/g,
			)) {
				if (
					MANAGED_COMMANDS.has(match[1]) &&
					relative !== "dispatch/runners/utils/runner-helpers.ts"
				) {
					violations.push(`${relative}: bare managed spawn ${match[1]}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
