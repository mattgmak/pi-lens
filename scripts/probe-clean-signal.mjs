#!/usr/bin/env node
/**
 * #240 clean-file affirmative-signal probe. For a push-only auxiliary (ast-grep),
 * does the server publish an empty-with-version set on a clean scan, or go silent?
 * Two transitions matter:
 *   - dirty→clean: clears stale diagnostics (most servers publish empty here)
 *   - clean→clean: a clean file edited and still clean (the Phase-2 common case;
 *     the worst case for an affirmative signal — nothing to clear, nothing to add)
 *
 * Run with PILENS_PUB_DEBUG=1 to see each server's publishes.
 *   PILENS_PUB_DEBUG=1 node scripts/probe-clean-signal.mjs
 * Requires `npm run build:dist`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sg-clean-"));
fs.writeFileSync(path.join(ws, "sgconfig.yml"), "ruleDirs:\n  - rules\n");
fs.mkdirSync(path.join(ws, "rules"));
fs.writeFileSync(
	path.join(ws, "rules", "no-console-log.yml"),
	"id: no-console-log\nlanguage: javascript\nseverity: error\nmessage: no console.log\nrule:\n  pattern: console.log($$$ARGS)\n",
);
try {
	execFileSync("git", ["init", "-q"], { cwd: ws, stdio: "ignore" });
} catch {}

// n console.log violations + a trailing marker so each "edit" changes bytes.
const js = (n, marker) =>
	`function f() {\n${Array.from({ length: n }, (_, i) => `  console.log("x${i}");`).join("\n")}\n}\nf();\n// edit ${marker}\n`;

const file = path.join(ws, "probe.js");
const { getLSPService, resetLSPService } = await import(
	pathToFileURL(path.join(repoRoot, "dist/clients/lsp/index.js")).href
);
const lsp = getLSPService();
const touch = (c) =>
	lsp.touchFile(file, c, {
		diagnostics: "document",
		collectDiagnostics: true,
		clientScope: "with-auxiliary",
		auxiliaryServerIds: ["ast-grep"],
		maxClientWaitMs: 30000,
		maxDiagnosticsWaitMs: 2500,
		source: "clean-probe",
	});
const sgCount = () =>
	(lsp.getDiagnostics ? [] : []) ||
	[]; // placeholder; we read from touch result below

async function step(label, n, marker) {
	fs.writeFileSync(file, js(n, marker));
	const t0 = performance.now();
	const r = await touch(js(n, marker));
	const dt = performance.now() - t0;
	const sg = Array.isArray(r)
		? r.filter((d) => /ast[-_]?grep/i.test(d.source || "")).length
		: "n/a";
	console.log(`${label}: wrote ${n} violations → ast-grep diags=${sg} in ${dt.toFixed(0)}ms`);
}

await step("cold (2 violations)", 2, "a");
await step("dirty→clean (0)", 0, "b");
await step("clean→clean (0)", 0, "c");
await step("clean→clean (0)", 0, "d");

try {
	await resetLSPService?.({ fast: true });
} catch {}
try {
	fs.rmSync(ws, { recursive: true, force: true });
} catch {}
process.exit(0);
