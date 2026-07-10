/**
 * Cross-process instance registry (#449 slice 1).
 *
 * Observability substrate for multi-agent LSP resource sharing. Records, in
 * a single machine-global file (`~/.pi-lens/instances.json`), every live
 * pi-lens process: its pid, project root, live LSP child servers, RSS, and a
 * heartbeat timestamp. Later slices (cross-process budget, same-root warm
 * attach) build on this; slice 1 is purely observational — it changes no
 * dispatch/LSP behavior, it only records state and reaps stale entries /
 * orphaned LSP children (#472).
 *
 * File shape: `{ instances: InstanceEntry[] }`. Missing or corrupt file is
 * treated as `{ instances: [] }` — this module must never throw on a read.
 *
 * Concurrency: every write is read-modify-write-whole-file with an atomic
 * tmp+rename (same pattern as clients/review-graph/builder.ts). Two
 * processes racing a write is a KNOWN, ACCEPTED race for slice 1
 * (last-writer-wins) — a lost update here only means a stale/missing
 * observability entry, never data corruption (the tmp+rename guarantees the
 * file itself is always valid JSON). A future slice can add file locking or
 * per-pid shard files if this proves too lossy in practice.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.js";
import { normalizeFilePath } from "./path-utils.js";

export interface LspChildEntry {
	pid: number;
	serverId: string;
	command: string;
	/** Per-spawn-unique marker (e.g. a temp sgconfig path) for command-line
	 *  re-identification when the pid itself is gone/recycled. */
	marker?: string;
	spawnedAt: string;
}

export interface InstanceEntry {
	pid: number;
	startedAt: string;
	projectRoot: string;
	lspChildren: LspChildEntry[];
	lspChildCount: number;
	rssBytes: number;
	heartbeatAt: string;
}

interface RegistryFile {
	instances: InstanceEntry[];
}

function registryPath(): string {
	return path.join(getGlobalPiLensDir(), "instances.json");
}

// --- Kill switch (lazy, memoized — house style per clients/runtime-config.ts) ---

let _enabledCache: boolean | undefined;

/**
 * `PI_LENS_INSTANCE_REGISTRY=0` disables the registry entirely: every
 * exported function in this module becomes a no-op (including the reaper
 * sweep in clients/instance-reaper.ts, which checks this too).
 */
export function isInstanceRegistryEnabled(): boolean {
	if (_enabledCache !== undefined) return _enabledCache;
	_enabledCache = process.env.PI_LENS_INSTANCE_REGISTRY !== "0";
	return _enabledCache;
}

/** Test-only: clear the memoized kill-switch read. */
export function _resetInstanceRegistryEnabledForTests(): void {
	_enabledCache = undefined;
}

// --- Read ---

function readRegistrySync(): RegistryFile {
	try {
		const raw = fs.readFileSync(registryPath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && Array.isArray(parsed.instances)) {
			return parsed as RegistryFile;
		}
		return { instances: [] };
	} catch {
		// Missing file, corrupt JSON, or wrong shape — treat as empty, never throw.
		return { instances: [] };
	}
}

async function readRegistryAsync(): Promise<RegistryFile> {
	try {
		const raw = await fs.promises.readFile(registryPath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && Array.isArray(parsed.instances)) {
			return parsed as RegistryFile;
		}
		return { instances: [] };
	} catch {
		return { instances: [] };
	}
}

/** Read-only snapshot of the whole registry (used by the reaper). */
export async function readInstanceRegistry(): Promise<InstanceEntry[]> {
	const file = await readRegistryAsync();
	return file.instances;
}

// --- Write (atomic tmp + rename, same pattern as review-graph/builder.ts) ---

async function writeRegistryAsync(file: RegistryFile): Promise<void> {
	const dir = getGlobalPiLensDir();
	const target = registryPath();
	const tmpPath = `${target}.tmp-${process.pid}`;
	try {
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(tmpPath, JSON.stringify(file), "utf-8");
		await fs.promises.rename(tmpPath, target);
	} catch {
		// Best-effort observability substrate — a failed write just means this
		// update is lost, never a thrown error for the caller.
		try {
			await fs.promises.rm(tmpPath, { force: true });
		} catch {
			// ignore
		}
	}
}

function writeRegistrySync(file: RegistryFile): void {
	const dir = getGlobalPiLensDir();
	const target = registryPath();
	const tmpPath = `${target}.tmp-${process.pid}`;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tmpPath, JSON.stringify(file), "utf-8");
		fs.renameSync(tmpPath, target);
	} catch {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			// ignore
		}
	}
}

// --- Mutations (all read-modify-write whole file) ---

/** Create/overwrite this process's entry. */
export async function registerInstance(projectRoot: string): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const normalizedRoot = normalizeFilePath(projectRoot);
	const file = await readRegistryAsync();
	const now = new Date().toISOString();
	const others = file.instances.filter((entry) => entry.pid !== pid);
	const existing = file.instances.find((entry) => entry.pid === pid);
	others.push({
		pid,
		startedAt: existing?.startedAt ?? now,
		projectRoot: normalizedRoot,
		lspChildren: existing?.lspChildren ?? [],
		lspChildCount: existing?.lspChildren?.length ?? 0,
		rssBytes: process.memoryUsage().rss,
		heartbeatAt: now,
	});
	await writeRegistryAsync({ instances: others });
}

export interface HeartbeatPatch {
	rssBytes?: number;
}

/** Update this process's heartbeat/rss. Cheap — safe to call every turn end. */
export async function updateHeartbeat(patch: HeartbeatPatch = {}): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const file = await readRegistryAsync();
	const idx = file.instances.findIndex((entry) => entry.pid === pid);
	if (idx === -1) {
		// No prior registerInstance in this run (e.g. registry file was reaped
		// out from under us, or heartbeat fired before session_start finished) —
		// nothing to update against; skip rather than fabricate a projectRoot.
		return;
	}
	const now = new Date().toISOString();
	const current = file.instances[idx];
	file.instances[idx] = {
		...current,
		rssBytes: patch.rssBytes ?? process.memoryUsage().rss,
		lspChildCount: current.lspChildren.length,
		heartbeatAt: now,
	};
	await writeRegistryAsync(file);
}

export interface RecordLspChildInput {
	pid: number;
	serverId: string;
	command: string;
	marker?: string;
}

/** Append/replace (by pid) an LSP child under this process's entry. */
export async function recordLspChild(entry: RecordLspChildInput): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const file = await readRegistryAsync();
	const idx = file.instances.findIndex((inst) => inst.pid === pid);
	const now = new Date().toISOString();
	const childEntry: LspChildEntry = {
		pid: entry.pid,
		serverId: entry.serverId,
		command: entry.command,
		marker: entry.marker,
		spawnedAt: now,
	};
	if (idx === -1) {
		// registerInstance hasn't run yet in this process (or was reaped) —
		// synthesize a minimal entry so the child is still tracked.
		file.instances.push({
			pid,
			startedAt: now,
			projectRoot: normalizeFilePath(process.cwd()),
			lspChildren: [childEntry],
			lspChildCount: 1,
			rssBytes: process.memoryUsage().rss,
			heartbeatAt: now,
		});
	} else {
		const current = file.instances[idx];
		const filtered = current.lspChildren.filter(
			(child) => child.pid !== entry.pid,
		);
		filtered.push(childEntry);
		file.instances[idx] = {
			...current,
			lspChildren: filtered,
			lspChildCount: filtered.length,
		};
	}
	await writeRegistryAsync(file);
}

/** Remove an LSP child (by pid) from this process's entry. */
export async function removeLspChild(pid: number): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const selfPid = process.pid;
	const file = await readRegistryAsync();
	const idx = file.instances.findIndex((inst) => inst.pid === selfPid);
	if (idx === -1) return;
	const current = file.instances[idx];
	const filtered = current.lspChildren.filter((child) => child.pid !== pid);
	if (filtered.length === current.lspChildren.length) return; // nothing removed
	file.instances[idx] = {
		...current,
		lspChildren: filtered,
		lspChildCount: filtered.length,
	};
	await writeRegistryAsync(file);
}

/**
 * Remove this process's entry entirely. SYNC fs only — safe to call from
 * `session_shutdown` (#234: no child spawns permitted at teardown; this
 * function spawns nothing).
 */
export function deregisterInstance(): void {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const file = readRegistrySync();
	const remaining = file.instances.filter((entry) => entry.pid !== pid);
	if (remaining.length === file.instances.length) return; // nothing to remove
	writeRegistrySync({ instances: remaining });
}
