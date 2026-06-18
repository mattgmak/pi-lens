import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

type MockRenameClient = {
	root: string;
	isAlive: ReturnType<typeof vi.fn>;
	willRenameFiles: ReturnType<typeof vi.fn>;
	didRenameFiles: ReturnType<typeof vi.fn>;
};

function makeClient(root: string, edit: unknown): MockRenameClient {
	return {
		root,
		isAlive: vi.fn(() => true),
		willRenameFiles: vi.fn(async () => edit),
		didRenameFiles: vi.fn(async () => undefined),
	};
}

function addClient(
	service: LSPService,
	serverId: string,
	root: string,
	client: MockRenameClient,
): void {
	const state = (
		service as unknown as { state: { clients: Map<string, unknown> } }
	).state;
	state.clients.set(`${serverId}:${normalizeMapKey(root)}`, client);
}

describe("LSPService.renameFile", () => {
	it("merges willRenameFiles edits by client priority, renames, and notifies all active clients", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		const importPath = path.join(tmpDir, "import.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		fs.writeFileSync(importPath, "import { value } from './old';\n", "utf-8");
		const importUri = pathToFileURL(importPath).href;

		const primary = makeClient(tmpDir, {
			changes: {
				[importUri]: [
					{
						range: {
							start: { line: 0, character: 25 },
							end: { line: 0, character: 28 },
						},
						newText: "new",
					},
				],
			},
		});
		const secondary = makeClient(tmpDir, {
			changes: {
				[importUri]: [
					{
						range: {
							start: { line: 0, character: 23 },
							end: { line: 0, character: 28 },
						},
						newText: "./new",
					},
				],
			},
		});

		const service = new LSPService();
		addClient(service, "typescript", tmpDir, primary);
		addClient(service, "eslint", tmpDir, secondary);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.droppedConflicts).toBe(1);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf-8")).toBe(
				"export const value = 1;\n",
			);
			expect(fs.readFileSync(importPath, "utf-8")).toBe(
				"import { value } from './new';\n",
			);
			expect(primary.willRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(secondary.willRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(primary.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(secondary.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("previews with no active clients without touching the filesystem", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");

		try {
			const result = await new LSPService().renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: false,
			});

			expect(result).toMatchObject({
				applied: false,
				serverIds: [],
				droppedConflicts: 0,
				inputEditCount: 0,
				summary: [],
			});
			expect(fs.existsSync(oldPath)).toBe(true);
			expect(fs.existsSync(newPath)).toBe(false);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("applies a plain filesystem rename when no clients are active", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");

		try {
			const result = await new LSPService().renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.serverIds).toEqual([]);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf-8")).toBe(
				"export const value = 1;\n",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("records a willRenameFiles failure while still using successful server edits", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		const importPath = path.join(tmpDir, "import.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		fs.writeFileSync(importPath, "import { value } from './old';\n", "utf-8");

		const success = makeClient(tmpDir, {
			changes: {
				[pathToFileURL(importPath).href]: [
					{
						range: {
							start: { line: 0, character: 25 },
							end: { line: 0, character: 28 },
						},
						newText: "new",
					},
				],
			},
		});
		const failing = makeClient(tmpDir, null);
		failing.willRenameFiles.mockRejectedValueOnce(new Error("eslint down"));
		const service = new LSPService();
		addClient(service, "typescript", tmpDir, success);
		addClient(service, "eslint", tmpDir, failing);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.willRenameFailures).toEqual([
				{ serverId: "eslint", error: "eslint down" },
			]);
			expect(fs.readFileSync(importPath, "utf-8")).toBe(
				"import { value } from './new';\n",
			);
			expect(success.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(failing.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("rejects and leaves files untouched when every willRenameFiles request fails", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const failing = makeClient(tmpDir, null);
		failing.willRenameFiles.mockRejectedValueOnce(new Error("server down"));
		const service = new LSPService();
		addClient(service, "typescript", tmpDir, failing);

		try {
			await expect(
				service.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true }),
			).rejects.toThrow(
				/workspace\/willRenameFiles failed for all active LSP servers/,
			);
			expect(fs.existsSync(oldPath)).toBe(true);
			expect(fs.existsSync(newPath)).toBe(false);
			expect(failing.didRenameFiles).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("records didRenameFiles failures after a successful disk rename", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const client = makeClient(tmpDir, null);
		client.didRenameFiles.mockRejectedValueOnce(new Error("notify failed"));
		const service = new LSPService();
		addClient(service, "typescript", tmpDir, client);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.didRenameFailures).toEqual([
				{ serverId: "typescript", error: "notify failed" },
			]);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.existsSync(newPath)).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
