import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../file-utils.js";
import type { ProjectDiagnosticsSnapshot } from "./types.js";

export const PROJECT_DIAGNOSTICS_CACHE_VERSION = 1;
const CACHE_FILE = "project-diagnostics.json";

function cachePath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", CACHE_FILE);
}

export function loadProjectDiagnosticsSnapshot(
	cwd: string,
): ProjectDiagnosticsSnapshot | undefined {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(cachePath(cwd), "utf-8"),
		) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const snapshot = parsed as ProjectDiagnosticsSnapshot;
		if (snapshot.version !== PROJECT_DIAGNOSTICS_CACHE_VERSION)
			return undefined;
		if (!Array.isArray(snapshot.diagnostics)) return undefined;
		return snapshot;
	} catch {
		return undefined;
	}
}

export function saveProjectDiagnosticsSnapshot(
	cwd: string,
	snapshot: ProjectDiagnosticsSnapshot,
): void {
	const filePath = cachePath(cwd);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
}
