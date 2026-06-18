#!/usr/bin/env node
/**
 * #240 affirmative-clean-signal characterization across servers. For each
 * installed server, reports its diagnostic mode (pull vs push-only) — the first
 * cut at "how can we confirm a clean file is clean":
 *   - pull        → active pull gives an authoritative clean answer
 *   - push-only   → depends on whether it re-publishes empty (ast-grep) or goes
 *                   silent (typescript) on a clean edit — needs behavior testing
 *
 *   node scripts/characterize-lsp.mjs [lang ...]
 * Requires `npm run build:dist`. Measures only already-installed servers.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const install = argv.includes("--install");
const langs = argv.filter((a) => !a.startsWith("--"));
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { LSP_FIXTURES } = await imp("scripts/smoke-tools.mjs");
const { getLSPService, resetLSPService } = await imp("dist/clients/lsp/index.js");
const { initLSPConfig } = await imp("dist/clients/lsp/config.js");
let ensureTool;
if (install) ({ ensureTool } = await imp("dist/clients/installer/index.js"));

const fixtures = langs.length
	? LSP_FIXTURES.filter((f) => langs.includes(f.lang))
	: LSP_FIXTURES;
const lsp = getLSPService();
const rows = [];

for (const fx of fixtures) {
	const dst = fs.mkdtempSync(path.join(os.tmpdir(), "char-lsp-"));
	fs.cpSync(path.join(repoRoot, fx.dir), dst, { recursive: true });
	const absFile = path.join(dst, fx.file);
	if (fx.gitInit) {
		try { execFileSync("git", ["init", "-q"], { cwd: dst, stdio: "ignore" }); } catch {}
	}
	if (fx.disableServers) {
		fs.mkdirSync(path.join(dst, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(dst, ".pi-lens", "lsp.json"),
			JSON.stringify({ disabledServers: fx.disableServers }, null, 2),
		);
		await initLSPConfig(dst);
	}
	if (install && ensureTool) {
		for (const t of fx.tools ?? []) await ensureTool(t).catch(() => undefined);
	}
	if (!lsp.supportsLSP(absFile)) {
		rows.push({ lang: fx.lang, server: fx.serverHint, mode: "no-lsp" });
		continue;
	}
	const auxIds = fx.auxiliaryServerIds ?? [];
	try {
		const content = fs.readFileSync(absFile, "utf8");
		await lsp.touchFile(absFile, content, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: auxIds.length ? "with-auxiliary" : "primary",
			...(auxIds.length ? { auxiliaryServerIds: auxIds } : {}),
			maxClientWaitMs: 30000,
			maxDiagnosticsWaitMs: 2500,
			source: "characterize",
		});
		const support = await lsp.getWorkspaceDiagnosticsSupport(absFile);
		rows.push({ lang: fx.lang, server: fx.serverHint, mode: support?.mode ?? "unknown" });
		console.error(`[${fx.lang}] mode=${support?.mode ?? "unknown"}`);
	} catch (e) {
		rows.push({ lang: fx.lang, server: fx.serverHint, mode: `error: ${e?.message ?? e}` });
	} finally {
		try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
	}
}

console.log("\nDiagnostic-mode matrix (affirmative-clean-signal first cut)\n");
console.log(`  ${"LANG".padEnd(16)} ${"MODE".padEnd(12)} SERVER`);
for (const r of rows.sort((a, b) => String(a.mode).localeCompare(String(b.mode)))) {
	console.log(`  ${r.lang.padEnd(16)} ${String(r.mode).padEnd(12)} ${r.server}`);
}
const pull = rows.filter((r) => r.mode === "pull").length;
const push = rows.filter((r) => r.mode === "push-only").length;
console.log(`\n  pull-capable (clean confirmable via pull): ${pull}`);
console.log(`  push-only (needs re-publish-empty, else silent → budget-bound): ${push}`);

try { await resetLSPService?.({ fast: true }); } catch {}
process.exit(0);
