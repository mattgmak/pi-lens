import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePackagePath } from "./package-root.js";
import { walkUpDirs } from "./path-utils.js";

// ast-grep's root config marker. The `ast-grep lsp` server is workspace-gated:
// it only operates in a project that has an `sgconfig.y[a]ml` at (or above) the
// file. These are the names ast-grep itself looks for as root markers.
export const SGCONFIG_NAMES = ["sgconfig.yml", "sgconfig.yaml"] as const;

/**
 * Nearest `sgconfig.y[a]ml` walking up from `startDir`, or undefined if none.
 * Used both to gate the ast-grep LSP server (no sgconfig ⇒ it never attaches,
 * so the napi runner stays the path) and to decide blocking eligibility (a repo
 * sgconfig is the team's deliberately-authored ruleset, like a curated opengrep
 * config — see clients/dispatch/auxiliary-lsp.ts).
 */
export function findLocalSgconfig(startDir: string): string | undefined {
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		for (const name of SGCONFIG_NAMES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/** The shipped ast-grep rule dirs (dev cwd first, then the installed package). */
function findShippedRuleDirs(): string[] {
	const candidates = [
		path.join(process.cwd(), "rules", "ast-grep-rules", "rules"),
		path.join(process.cwd(), "rules", "ast-grep-rules", "coderabbit", "rules"),
		resolvePackagePath(import.meta.url, "rules", "ast-grep-rules", "rules"),
		resolvePackagePath(
			import.meta.url,
			"rules",
			"ast-grep-rules",
			"coderabbit",
			"rules",
		),
	];
	return Array.from(new Set(candidates.filter((d) => fs.existsSync(d))));
}

let cachedBaselinePath: string | undefined;

/**
 * Synthesize (once) an sgconfig that points ast-grep at pi-lens's SHIPPED rules
 * (the native pi-lens rule dir plus vendored CodeRabbit essentials), for the
 * no-project-sgconfig baseline (#239 Phase 2): the ast-grep LSP attaches
 * everywhere and is launched with `lsp --config <this>` so it scans the shipped
 * ruleset just as the napi runner did. `ruleDirs` is absolute (this file lives in
 * a temp dir, not the package) and forward-slashed (ast-grep accepts `/` on
 * Windows; backslashes in a YAML scalar would need escaping). Returns undefined
 * if the shipped rules can't be located — the caller then launches plain `lsp`.
 */
export function resolveBaselineSgconfig(): string | undefined {
	if (cachedBaselinePath && fs.existsSync(cachedBaselinePath)) {
		return cachedBaselinePath;
	}
	const ruleDirs = findShippedRuleDirs();
	if (ruleDirs.length === 0) return undefined;
	const dir = path.join(os.tmpdir(), "pi-lens-ast-grep");
	fs.mkdirSync(dir, { recursive: true });
	// Per-PROCESS filename (#472): the config path doubles as the orphan
	// reaper's command-line marker, so it must be unique per instance — a
	// shared filename would make the reaper's marker-fallback match every
	// live session's ast-grep on the machine.
	const file = path.join(dir, `baseline-${process.pid}.sgconfig.yml`);
	cleanupStaleBaselines(dir, file);
	const ruleDirsForYaml = ruleDirs
		.map((ruleDir) => `  - "${ruleDir.split(path.sep).join("/")}"`)
		.join("\n");
	fs.writeFileSync(file, `ruleDirs:\n${ruleDirsForYaml}\n`);
	cachedBaselinePath = file;
	return file;
}

/** Best-effort removal of baseline configs left by dead processes (per-pid
 * filenames accumulate). Age-based (>7 days) so a live long-running session's
 * file is never touched; fs-only, never throws. */
function cleanupStaleBaselines(dir: string, keep: string): void {
	try {
		const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const name of fs.readdirSync(dir)) {
			if (!/^baseline(-\d+)?\.sgconfig\.yml$/.test(name)) continue;
			const full = path.join(dir, name);
			if (full === keep) continue;
			try {
				if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
			} catch {
				// racing another session — skip
			}
		}
	} catch {
		// missing dir / permission — nothing to clean
	}
}

/** Test-only: reset the memoized baseline sgconfig path. */
export function _resetBaselineSgconfigForTests(): void {
	cachedBaselinePath = undefined;
}
