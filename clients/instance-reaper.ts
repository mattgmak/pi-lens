/**
 * Orphaned LSP process reaper (#472), built on the instance registry (#449
 * slice 1).
 *
 * Split into a PURE decision function (`decideOrphanReaping`) and an IMPURE
 * sweep (`sweepOrphans`) so the decision logic is unit-testable with fake
 * pid tables — no real process spawns/kills in tests.
 *
 * Why the registry reaper, not EOF/processId alone (see issue #472): both are
 * best-effort hints a well-behaved server may honor (typescript-language-server
 * does; ast-grep's native exe does not — an upstream LSP-spec violation). The
 * registry reaper works regardless of why a stdin pipe write-end stayed open
 * after the parent died (Windows handle-inheritance capture) — it identifies
 * dead-parent instances directly and kills the full recorded child tree, with
 * a command-line marker fallback for the case where the pid itself was
 * recycled or the mid-tree pid link is broken (e.g. a dead node-wrapper whose
 * native-exe grandchild is still alive under a different, unrecorded pid).
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.js";
import {
	type InstanceEntry,
	isInstanceRegistryEnabled,
	readInstanceRegistry,
} from "./instance-registry.js";
import { logLatency } from "./latency-logger.js";

const isWindows = process.platform === "win32";

export interface ChildToKill {
	pid: number;
	serverId: string;
	command: string;
}

export interface MarkerSearch {
	marker: string;
	serverId: string;
}

export interface OrphanReapDecision {
	/** Registry entries whose owning pid is confirmed dead — to be dropped
	 *  from the registry once their children are reaped. */
	deadInstances: InstanceEntry[];
	/** Live-pid LSP children belonging to a dead-parent instance — kill these. */
	childrenToKill: ChildToKill[];
	/** Children whose pid is ALSO dead (or already gone) but that carried a
	 *  marker — surfaced so the caller can command-line-search for a live
	 *  process still holding that marker (broken pid chain: e.g. a dead
	 *  node-wrapper whose exec'd native child kept a different, unrecorded pid). */
	markerSearches: MarkerSearch[];
}

/**
 * Pure decision function: given the registry state and injectable liveness /
 * identity predicates, decide what to kill. Performs zero I/O.
 *
 * @param isPidAlive - `process.kill(pid, 0)`-style liveness check. Must be
 *   CONSERVATIVE: only pid-confirmed-dead (ESRCH) counts as dead. Any
 *   ambiguous result (EPERM, or the caller's fake table saying "unknown")
 *   must be treated as alive — never kill on an ambiguous signal-check.
 * @param matchProcess - optional identity verification (e.g. confirm the
 *   live pid's command line still matches what we recorded) to guard against
 *   a recycled pid coincidentally matching. If omitted, liveness alone is used.
 */
export function decideOrphanReaping(
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
	matchProcess?: (
		pid: number,
		expected: { command: string; marker?: string },
	) => boolean,
): OrphanReapDecision {
	const deadInstances: InstanceEntry[] = [];
	const childrenToKill: ChildToKill[] = [];
	const markerSearches: MarkerSearch[] = [];

	for (const instance of registry) {
		if (isPidAlive(instance.pid)) {
			continue; // parent still alive — leave its children alone entirely
		}
		deadInstances.push(instance);

		for (const child of instance.lspChildren) {
			const childAlive = isPidAlive(child.pid);
			if (childAlive) {
				const identityOk = matchProcess
					? matchProcess(child.pid, {
							command: child.command,
							marker: child.marker,
						})
					: true;
				if (identityOk) {
					childrenToKill.push({
						pid: child.pid,
						serverId: child.serverId,
						command: child.command,
					});
					continue;
				}
			}
			// Child pid is dead, or alive-but-identity-mismatched (recycled pid) —
			// if we have a marker, surface it so the caller can find a live
			// process (e.g. the native exe grandchild) by command-line match.
			if (child.marker) {
				markerSearches.push({ marker: child.marker, serverId: child.serverId });
			}
		}
	}

	return { deadInstances, childrenToKill, markerSearches };
}

// --- Impure liveness / identity / kill helpers ---

/** `process.kill(pid, 0)` liveness check: ESRCH ⇒ dead, anything else
 *  (EPERM, or no error thrown at all) ⇒ conservatively alive. */
function realIsPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true; // no throw — process exists and we can signal it
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return false; // definitively dead
		// EPERM (exists, no permission) or any other/unknown errno: ambiguous —
		// never treat as dead.
		return true;
	}
}

function windowsExe(name: string): string {
	return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\${name}`;
}

/** Escape a value for embedding in a WQL LIKE clause: WQL uses `'` as the
 *  string delimiter (doubled to escape) and `%`/`_` as wildcards — the marker
 *  is an opaque path string, so escape all three before interpolating. */
function escapeWqlLikeValue(value: string): string {
	return value.replace(/'/g, "''").replace(/[%_]/g, (ch) => `[${ch}]`);
}

/** Search running processes whose command line contains `marker` (Windows,
 *  via CIM/WQL). Returns matching pids. Best-effort: any failure ⇒ []. */
async function findPidsByMarkerWindows(marker: string): Promise<number[]> {
	if (!isWindows || !marker) return [];
	const escaped = escapeWqlLikeValue(marker);
	const psScript =
		`Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${escaped}%'" ` +
		`| Select-Object -ExpandProperty ProcessId`;
	return new Promise((resolve) => {
		try {
			const powershell = windowsExe(
				"WindowsPowerShell\\v1.0\\powershell.exe",
			);
			const child = nodeSpawn(
				powershell,
				["-NoProfile", "-NonInteractive", "-Command", psScript],
				{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.once("error", () => resolve([]));
			child.once("close", () => {
				const pids = out
					.split(/\r?\n/)
					.map((line) => Number(line.trim()))
					.filter((n) => Number.isFinite(n) && n > 0);
				resolve(pids);
			});
		} catch {
			resolve([]);
		}
	});
}

/** Force-kill a pid's full process tree. Windows: `taskkill /F /T`. POSIX:
 *  mirror killProcessTree's process-group kill, falling back to a direct
 *  signal. Best-effort: swallow all errors. */
async function killPidTree(pid: number): Promise<void> {
	if (!Number.isFinite(pid) || pid <= 0) return;
	if (isWindows) {
		try {
			const taskkill = windowsExe("taskkill.exe");
			const killer = nodeSpawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
				shell: false,
				windowsHide: true,
				stdio: "ignore",
			});
			await new Promise<void>((resolve) => {
				killer.once("close", () => resolve());
				killer.once("error", () => resolve());
			});
		} catch {
			// best-effort
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// best-effort — process may already be gone
		}
	}
}

/**
 * Fire-and-forget orphan sweep: reads the registry, decides what's dead via
 * `decideOrphanReaping`, kills orphaned LSP children (by pid, with a
 * marker-based command-line search fallback), then drops fully-dead
 * instances from the registry. Never throws — every step is wrapped so a
 * reap failure cannot block or crash the caller (session_start).
 */
export async function sweepOrphans(): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const startedAt = Date.now();
	try {
		const registry = await readInstanceRegistry();
		if (registry.length === 0) return;

		const decision = decideOrphanReaping(registry, realIsPidAlive);

		let killedCount = 0;
		const killedServerIds: string[] = [];

		for (const child of decision.childrenToKill) {
			await killPidTree(child.pid);
			killedCount++;
			killedServerIds.push(child.serverId);
		}

		for (const search of decision.markerSearches) {
			try {
				const pids = await findPidsByMarkerWindows(search.marker);
				for (const pid of pids) {
					await killPidTree(pid);
					killedCount++;
					killedServerIds.push(search.serverId);
				}
			} catch {
				// best-effort — a failed marker search just misses that orphan this sweep
			}
		}

		if (decision.deadInstances.length > 0) {
			try {
				const deadPids = new Set(decision.deadInstances.map((i) => i.pid));
				await pruneDeadInstances(deadPids);
			} catch {
				// best-effort — a stale registry entry is re-evaluated next sweep
			}
		}

		try {
			logLatency({
				type: "phase",
				phase: "orphan_lsp_reaped",
				filePath: "",
				durationMs: Date.now() - startedAt,
				metadata: {
					deadInstances: decision.deadInstances.length,
					killed: killedCount,
					serverIds: killedServerIds,
					markerSearches: decision.markerSearches.length,
				},
			});
		} catch {
			// best-effort logging only
		}
	} catch {
		// The sweep must never throw out of session_start.
	}
}

/** Drop dead-parent instances from the registry. Re-reads immediately before
 *  writing (rather than reusing the earlier `readInstanceRegistry()` snapshot)
 *  to narrow — not eliminate — the last-writer-wins race already accepted for
 *  slice 1's read-modify-write model. */
async function pruneDeadInstances(deadPids: Set<number>): Promise<void> {
	const target = path.join(getGlobalPiLensDir(), "instances.json");
	try {
		const raw = await fs.promises.readFile(target, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.instances)) return;
		const remaining = parsed.instances.filter(
			(entry: InstanceEntry) => !deadPids.has(entry.pid),
		);
		if (remaining.length === parsed.instances.length) return;
		const tmpPath = `${target}.tmp-${process.pid}`;
		await fs.promises.mkdir(getGlobalPiLensDir(), { recursive: true });
		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify({ instances: remaining }),
			"utf-8",
		);
		await fs.promises.rename(tmpPath, target);
	} catch {
		// best-effort
	}
}
