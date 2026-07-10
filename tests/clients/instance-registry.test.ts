/**
 * Tests for clients/instance-registry.ts (#449 slice 1) — the cross-process
 * observability substrate: read/write atomicity, corrupt/missing-file
 * recovery, cross-form path normalization, and the kill switch.
 *
 * `getGlobalPiLensDir` is mocked to point at a per-test temp dir so these
 * tests never touch the real `~/.pi-lens/instances.json`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../clients/file-utils.js", () => ({
	getGlobalPiLensDir: () => dir,
}));

describe("instance-registry", () => {
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-instreg-"));
		vi.resetModules();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function registryFilePath(): string {
		return path.join(dir, "instances.json");
	}

	it("registerInstance creates a fresh entry for this pid", async () => {
		const { registerInstance } = await import("../../clients/instance-registry.js");
		await registerInstance("/some/project");

		const raw = fs.readFileSync(registryFilePath(), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.instances).toHaveLength(1);
		expect(parsed.instances[0].pid).toBe(process.pid);
		expect(parsed.instances[0].projectRoot).toContain("some/project");
		expect(parsed.instances[0].lspChildren).toEqual([]);
	});

	it("registerInstance overwrites (not duplicates) this pid's prior entry", async () => {
		const { registerInstance } = await import("../../clients/instance-registry.js");
		await registerInstance("/first/root");
		await registerInstance("/second/root");

		const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
		expect(parsed.instances).toHaveLength(1);
		expect(parsed.instances[0].projectRoot).toContain("second/root");
	});

	it("writes atomically via tmp-<pid> + rename (no tmp file left behind, no torn write)", async () => {
		const { registerInstance } = await import("../../clients/instance-registry.js");
		await registerInstance("/atomic/project");

		const entries = fs.readdirSync(dir);
		expect(entries).toContain("instances.json");
		expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
	});

	it("corrupt JSON in the registry file is treated as empty, never throws", async () => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(registryFilePath(), "{not valid json!!", "utf-8");

		const { registerInstance } = await import("../../clients/instance-registry.js");
		await expect(registerInstance("/recovered/project")).resolves.not.toThrow();

		const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
		expect(parsed.instances).toHaveLength(1);
	});

	it("missing registry file on first read/write does not throw", async () => {
		const { registerInstance, readInstanceRegistry } = await import(
			"../../clients/instance-registry.js"
		);
		expect(fs.existsSync(registryFilePath())).toBe(false);
		await expect(registerInstance("/fresh/project")).resolves.not.toThrow();
		const instances = await readInstanceRegistry();
		expect(instances).toHaveLength(1);
	});

	it("recordLspChild appends a child under this pid's entry", async () => {
		const { registerInstance, recordLspChild, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await recordLspChild({
			pid: 99999,
			serverId: "ast-grep",
			command: "C:\\fake\\ast-grep.exe",
			marker: "C:\\temp\\pi-lens-ast-grep\\baseline.sgconfig.yml",
		});

		const instances = await readInstanceRegistry();
		expect(instances).toHaveLength(1);
		expect(instances[0].lspChildren).toHaveLength(1);
		expect(instances[0].lspChildren[0].serverId).toBe("ast-grep");
		expect(instances[0].lspChildCount).toBe(1);
	});

	it("recordLspChild replaces (not duplicates) an existing pid", async () => {
		const { registerInstance, recordLspChild, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await recordLspChild({ pid: 111, serverId: "ast-grep", command: "a" });
		await recordLspChild({ pid: 111, serverId: "ast-grep", command: "b" });

		const instances = await readInstanceRegistry();
		expect(instances[0].lspChildren).toHaveLength(1);
		expect(instances[0].lspChildren[0].command).toBe("b");
	});

	it("removeLspChild drops the child by pid", async () => {
		const { registerInstance, recordLspChild, removeLspChild, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await recordLspChild({ pid: 222, serverId: "typescript", command: "c" });
		await removeLspChild(222);

		const instances = await readInstanceRegistry();
		expect(instances[0].lspChildren).toHaveLength(0);
		expect(instances[0].lspChildCount).toBe(0);
	});

	it("recordLspChild works even without a prior registerInstance (synthesizes a minimal entry)", async () => {
		const { recordLspChild, readInstanceRegistry } = await import(
			"../../clients/instance-registry.js"
		);
		await recordLspChild({ pid: 333, serverId: "python", command: "d" });

		const instances = await readInstanceRegistry();
		expect(instances).toHaveLength(1);
		expect(instances[0].lspChildren).toHaveLength(1);
	});

	it("updateHeartbeat refreshes heartbeatAt and rssBytes for this pid", async () => {
		const { registerInstance, updateHeartbeat, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		const before = (await readInstanceRegistry())[0].heartbeatAt;

		await new Promise((r) => setTimeout(r, 5));
		await updateHeartbeat();

		const after = await readInstanceRegistry();
		expect(after[0].heartbeatAt).not.toBe(before);
		expect(after[0].rssBytes).toBeGreaterThan(0);
	});

	it("deregisterInstance removes this pid's entry synchronously", async () => {
		const { registerInstance, deregisterInstance, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		deregisterInstance();

		const instances = await readInstanceRegistry();
		expect(instances).toHaveLength(0);
	});

	it("deregisterInstance on an already-empty registry is a safe no-op", async () => {
		const { deregisterInstance } = await import("../../clients/instance-registry.js");
		expect(() => deregisterInstance()).not.toThrow();
	});

	it("cross-form project roots (backslash vs forward-slash) normalize to the same entry", async () => {
		const { registerInstance, readInstanceRegistry } = await import(
			"../../clients/instance-registry.js"
		);
		await registerInstance("C:\\foo\\bar");
		const first = (await readInstanceRegistry())[0].projectRoot;

		await registerInstance("C:/foo/bar");
		const instances = await readInstanceRegistry();

		expect(instances).toHaveLength(1); // same pid, same normalized root — one entry
		expect(instances[0].projectRoot).toBe(first);
	});

	describe("kill switch (PI_LENS_INSTANCE_REGISTRY=0)", () => {
		const originalEnv = process.env.PI_LENS_INSTANCE_REGISTRY;

		afterEach(() => {
			if (originalEnv === undefined) {
				delete process.env.PI_LENS_INSTANCE_REGISTRY;
			} else {
				process.env.PI_LENS_INSTANCE_REGISTRY = originalEnv;
			}
		});

		it("disables every mutating export as a no-op", async () => {
			process.env.PI_LENS_INSTANCE_REGISTRY = "0";
			const {
				registerInstance,
				recordLspChild,
				removeLspChild,
				updateHeartbeat,
				deregisterInstance,
				_resetInstanceRegistryEnabledForTests,
			} = await import("../../clients/instance-registry.js");
			_resetInstanceRegistryEnabledForTests();

			await registerInstance("/proj");
			await recordLspChild({ pid: 1, serverId: "x", command: "y" });
			await removeLspChild(1);
			await updateHeartbeat();
			deregisterInstance();

			expect(fs.existsSync(registryFilePath())).toBe(false);
		});

		it("re-enables when the env var is unset again (memoized cache reset)", async () => {
			process.env.PI_LENS_INSTANCE_REGISTRY = "0";
			const mod = await import("../../clients/instance-registry.js");
			mod._resetInstanceRegistryEnabledForTests();
			await mod.registerInstance("/proj");
			expect(fs.existsSync(registryFilePath())).toBe(false);

			delete process.env.PI_LENS_INSTANCE_REGISTRY;
			mod._resetInstanceRegistryEnabledForTests();
			await mod.registerInstance("/proj");
			expect(fs.existsSync(registryFilePath())).toBe(true);
		});
	});
});
