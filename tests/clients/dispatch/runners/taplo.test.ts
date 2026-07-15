import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn((..._args: unknown[]) => ({
	error: null,
	status: 0,
	stdout: "",
	stderr: "",
}));
const safeSpawnAsync = vi.fn((...args: Parameters<typeof safeSpawn>) =>
	Promise.resolve(safeSpawn(...args)),
);
vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

const lspPrimaryCoversFile = vi.fn((..._args: unknown[]) => false);
vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailable: () => true,
		isAvailableAsync: async () => true,
		getCommand: () => "taplo",
	}),
	resolveToolCommandWithInstallFallback: async () => "taplo",
	lspPrimaryCoversFile: (...args: unknown[]) => lspPrimaryCoversFile(...args),
}));

vi.mock("../../../../clients/tool-policy.js", () => ({
	getLinterPolicyForCwd: () => null,
}));

function createTomlCtx(filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind: "toml",
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("taplo runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		lspPrimaryCoversFile.mockReset();
		lspPrimaryCoversFile.mockReturnValue(false);
		safeSpawnAsync.mockImplementation((...args: Parameters<typeof safeSpawn>) =>
			Promise.resolve(safeSpawn(...args)),
		);
	});

	it("self-skips (no CLI spawn) when the toml LSP covers the file + taplo present (#233)", async () => {
		const env = setupTestEnvironment("pi-lens-taplo-");
		try {
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "a = 1\n");
			lspPrimaryCoversFile.mockReturnValue(true); // toml LSP (taplo lsp) is primary

			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;
			const result = await runner.run(
				createTomlCtx(filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("skipped");
			expect(safeSpawn).not.toHaveBeenCalled(); // no redundant CLI scan
		} finally {
			env.cleanup();
		}
	});

	it("still runs when taplo is unavailable as a tool (LSP can't cover) (#233)", async () => {
		const env = setupTestEnvironment("pi-lens-taplo-");
		try {
			const filePath = path.join(env.tmpDir, "config.toml");
			fs.writeFileSync(filePath, "a = 1\n");
			lspPrimaryCoversFile.mockReturnValue(true);
			safeSpawn.mockReturnValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({ errors: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/taplo.js")
			).default;
			// taplo not available → LSP can't actually cover → run the CLI
			const ctx = {
				...createTomlCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			};
			const result = await runner.run(ctx as never);

			expect(result.status).not.toBe("skipped");
			expect(safeSpawn).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
