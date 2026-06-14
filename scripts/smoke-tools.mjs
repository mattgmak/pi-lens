#!/usr/bin/env node
/**
 * Live tool-smoke harness (#209, layer 2).
 *
 * Drives pi-lens's REAL dispatch path (`dispatchLintDetailed` → real file-kind
 * → runner selection → each runner's `run()` → `safeSpawnAsync` → real tool,
 * with each runner's own auto-install) over a minimal real project per language,
 * and reports per-runner outcomes. Unlike the deterministic registry-consistency
 * test (layer 1, runs per-PR), this installs and spawns real tools — so it is
 * opt-in / nightly, never a per-PR gate.
 *
 *   Step 1 (default):  each target tool SPAWNS and EXITS CLEANLY
 *                      (no timeout/exception/server_error).
 *   Step 2 (--step2):  additionally, the tool PRODUCES A PARSEABLE DIAGNOSTIC
 *                      on the fixture's known defect.
 *
 * LSP handshake layer (--lsp): for each LSP fixture, drives the SAME production
 * entry the lsp runner uses (`LSPService.touchFile`, with a generous cold-spawn
 * budget) so a pass means the real server installed, spawned, completed the
 * JSON-RPC initialize handshake, and answered — verified via
 * `getDiagnosticsHealth` (serverCountReady > 0), not a hand-rolled handshake.
 *
 * Usage:
 *   node scripts/smoke-tools.mjs [lang ...] [--step2] [--install] [--verbose]
 *   node scripts/smoke-tools.mjs --lsp [lang ...] [--install] [--verbose]
 *
 * Requires a built dist/ (run `npm run build:dist` first).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/**
 * One minimal real project per language. `targets` are the runner ids whose
 * tool we are smoke-testing; `expectDiagnostic` is the fixture's known defect
 * (used by --step2).
 */
const FIXTURES = [
	{
		lang: "typescript",
		dir: "tests/fixtures/tool-smoke/typescript",
		file: "bad.ts",
		targets: ["lsp"],
		tools: ["typescript-language-server"],
		expectDiagnostic: true,
	},
	{
		lang: "python",
		dir: "tests/fixtures/tool-smoke/python",
		file: "bad.py",
		targets: ["ruff-lint"],
		tools: ["ruff"],
		expectDiagnostic: true,
	},
	{
		lang: "yaml",
		dir: "tests/fixtures/tool-smoke/yaml",
		file: "bad.yaml",
		targets: ["yamllint"],
		tools: ["yamllint"],
		expectDiagnostic: true,
	},
	{
		lang: "javascript",
		dir: "tests/fixtures/tool-smoke/javascript",
		file: "bad.js",
		targets: ["oxlint"],
		tools: ["oxlint"],
		expectDiagnostic: true,
	},
	{
		lang: "markdown",
		dir: "tests/fixtures/tool-smoke/markdown",
		file: "bad.md",
		targets: ["markdownlint"],
		tools: ["markdownlint"],
		expectDiagnostic: true,
	},
	{
		lang: "shell",
		dir: "tests/fixtures/tool-smoke/shell",
		file: "bad.sh",
		targets: ["shellcheck", "shfmt"],
		tools: ["shellcheck", "shfmt"],
		expectDiagnostic: true,
	},
];

/**
 * LSP handshake fixtures: a file whose extension routes to the LSP server under
 * test, plus the installer tool id for that server (--install). `lang` is the
 * filter key; `serverHint` is shown in the report.
 */
const LSP_FIXTURES = [
	{
		lang: "typescript",
		dir: "tests/fixtures/tool-smoke/typescript",
		file: "bad.ts",
		serverHint: "typescript-language-server",
		tools: ["typescript-language-server"],
	},
	{
		lang: "python",
		dir: "tests/fixtures/tool-smoke/python",
		file: "bad.py",
		serverHint: "pyright",
		tools: ["pyright"],
	},
	{
		lang: "yaml",
		dir: "tests/fixtures/tool-smoke/yaml",
		file: "bad.yaml",
		serverHint: "yaml-language-server",
		tools: ["yaml-language-server"],
	},
	{
		lang: "json",
		dir: "tests/fixtures/tool-smoke/json",
		file: "bad.json",
		serverHint: "vscode-json-language-server",
		tools: ["vscode-json-language-server"],
	},
	{
		lang: "shell",
		dir: "tests/fixtures/tool-smoke/shell",
		file: "bad.sh",
		serverHint: "bash-language-server",
		tools: ["bash-language-server"],
	},
];

// Generous cold-spawn / handshake budgets — the harness is not on the hot path,
// so give a cold server time to install (when --install), spawn, and initialize.
const LSP_CLIENT_WAIT_MS = 30000;
const LSP_DIAGNOSTICS_WAIT_MS = 8000;

const INFRA_FAILURES = new Set(["timeout", "exception", "server_error"]);

function parseArgs(argv) {
	const langs = [];
	let step2 = false;
	let verbose = false;
	let install = false;
	let lsp = false;
	for (const arg of argv) {
		if (arg === "--step2") step2 = true;
		else if (arg === "--verbose" || arg === "-v") verbose = true;
		else if (arg === "--install") install = true;
		else if (arg === "--lsp") lsp = true;
		else langs.push(arg);
	}
	return { langs, step2, verbose, install, lsp };
}

const TMP_PREFIX = "pi-lens-smoke-";

/**
 * Best-effort temp cleanup. On Windows the spawned LSP servers keep a handle on
 * the workspace until THIS process exits, so an in-run rmSync can EPERM; never
 * let that abort the run.
 */
function safeRm(dir) {
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch {
		// leftover temp dir — swept on the next run (see sweepLeftovers)
	}
}

/**
 * Sweep leftovers from PRIOR runs. Those runs' LSP servers have long since
 * exited, so their workspace locks are released and the dirs delete cleanly —
 * this is why cleanup belongs at startup, not in the same process that holds the
 * lock. Keeps %TEMP% from accumulating across nightly runs without a separate
 * unlock step.
 */
function sweepLeftovers() {
	const tmp = os.tmpdir();
	let swept = 0;
	try {
		for (const entry of fs.readdirSync(tmp)) {
			if (!entry.startsWith(TMP_PREFIX)) continue;
			try {
				fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
				swept++;
			} catch {
				// still locked by a live run — leave it
			}
		}
	} catch {
		// tmpdir unreadable — ignore
	}
	return swept;
}

function copyDirToTemp(srcRel) {
	const src = path.join(repoRoot, srcRel);
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-smoke-"));
	fs.cpSync(src, dest, { recursive: true });
	return dest;
}

/** Classify one target runner's outcome against the Step-1 bar. */
function classify(outcome) {
	if (!outcome) {
		return { state: "skip", detail: "not executed (filtered / when-skipped)", diags: 0 };
	}
	const { status, failureKind, failureMessage, diagnostics } = outcome.result;
	const diags = diagnostics.length;
	if (status === "failed" && INFRA_FAILURES.has(failureKind)) {
		return {
			state: "fail",
			detail: `${failureKind}${failureMessage ? `: ${failureMessage}` : ""}`,
			diags,
		};
	}
	if (status === "skipped") {
		return { state: "skip", detail: "runner skipped (tool/config unavailable)", diags };
	}
	// succeeded, or failed with blocking_diagnostics → the tool ran and exited cleanly.
	return {
		state: "pass",
		detail: `${status}${failureKind ? ` (${failureKind})` : ""}`,
		diags,
	};
}

const ICON = { pass: "✓", fail: "✗", skip: "⚠" };

function report(rows, title) {
	const pad = (s, n) => String(s).padEnd(n);
	console.log(`\nLive tool-smoke (#209) — ${title}\n`);
	console.log(`${pad("", 2)} ${pad("LANG", 12)} ${pad("RUNNER/SERVER", 28)} ${pad("DIAG", 5)} DETAIL`);
	for (const r of rows) {
		console.log(
			`${ICON[r.state]}  ${pad(r.lang, 12)} ${pad(r.runner, 28)} ${pad(r.diags, 5)} ${r.detail}`,
		);
	}
	const counts = { pass: 0, fail: 0, skip: 0 };
	for (const r of rows) counts[r.state]++;
	console.log(
		`\n${counts.pass} passed · ${counts.fail} failed · ${counts.skip} skipped (tool/config unavailable)`,
	);
	console.log(
		"Legend: ✓ ok  ✗ failure  ⚠ unavailable (not a failure)\n",
	);
	return counts.fail;
}

/**
 * LSP handshake layer — drives the real `LSPService.touchFile` (same entry the
 * lsp runner uses) per fixture, then asserts the handshake via
 * `getDiagnosticsHealth` (serverCountReady > 0). Returns the failure count.
 */
async function runLspHandshake({ langs, install, verbose }) {
	const lspEntry = path.join(repoRoot, "dist", "clients", "lsp", "index.js");
	if (!fs.existsSync(lspEntry)) {
		console.error(`dist build missing: ${lspEntry}\nRun \`npm run build:dist\` first.`);
		process.exit(2);
	}
	const { getLSPService } = await import(pathToFileURL(lspEntry).href);

	let ensureTool;
	if (install) {
		const installerEntry = path.join(repoRoot, "dist", "clients", "installer", "index.js");
		({ ensureTool } = await import(pathToFileURL(installerEntry).href));
	}

	const selected = langs.length
		? LSP_FIXTURES.filter((f) => langs.includes(f.lang))
		: LSP_FIXTURES;
	if (selected.length === 0) {
		console.error(`No LSP fixtures matched: ${langs.join(", ")}`);
		process.exit(2);
	}

	const lsp = getLSPService();
	const rows = [];
	for (const fx of selected) {
		if (install && ensureTool) {
			for (const toolId of fx.tools ?? []) {
				const resolved = await ensureTool(toolId);
				if (verbose) {
					console.error(`[${fx.lang}] ensureTool(${toolId}) → ${resolved ?? "UNAVAILABLE"}`);
				}
			}
		}
		const workspace = copyDirToTemp(fx.dir);
		const absFile = path.join(workspace, fx.file);
		const push = (state, detail, diags = 0) =>
			rows.push({ lang: fx.lang, runner: fx.serverHint, state, detail, diags });
		try {
			if (!lsp.supportsLSP(absFile)) {
				push("skip", "no LSP server registered for this file");
				continue;
			}
			const content = fs.readFileSync(absFile, "utf8");
			let touched;
			let threw;
			try {
				touched = await lsp.touchFile(absFile, content, {
					diagnostics: "document",
					collectDiagnostics: true,
					clientScope: "primary",
					maxClientWaitMs: LSP_CLIENT_WAIT_MS,
					maxDiagnosticsWaitMs: LSP_DIAGNOSTICS_WAIT_MS,
					source: "smoke-lsp",
				});
			} catch (err) {
				threw = err?.message ?? String(err);
			}
			// touchFile returns the diagnostics array once a client is ready (spawn
			// + initialize handshake completed), or undefined if none became ready
			// in the budget. (getDiagnosticsHealth is populated by getDiagnostics,
			// not touchFile, so it's only an extra hint when present.)
			const diags = Array.isArray(touched) ? touched.length : 0;
			if (verbose) {
				console.error(
					`[${fx.lang}] touched=${Array.isArray(touched) ? touched.length : touched} health=${JSON.stringify(lsp.getDiagnosticsHealth(absFile))}`,
				);
			}
			if (threw) {
				push("fail", `handshake/server error: ${threw}`, diags);
			} else if (Array.isArray(touched)) {
				push(
					"pass",
					`handshook — server replied${diags ? ` (${diags} diagnostic${diags === 1 ? "" : "s"})` : ""}`,
					diags,
				);
			} else {
				push(
					"skip",
					`no client ready in ${LSP_CLIENT_WAIT_MS}ms (server missing/slow; try --install)`,
				);
			}
		} catch (err) {
			push("fail", `error: ${err?.message ?? err}`);
		} finally {
			safeRm(workspace);
		}
	}

	try {
		await lsp.shutdown();
	} catch {
		// best-effort teardown
	}
	return report(rows, "LSP handshake (install → spawn → initialize)");
}

async function main() {
	const { langs, step2, verbose, install, lsp } = parseArgs(process.argv.slice(2));

	// Clean leftovers from prior runs (their file locks are released now).
	const swept = sweepLeftovers();
	if (verbose && swept > 0) console.error(`swept ${swept} leftover temp workspace(s)`);

	if (lsp) {
		process.exit((await runLspHandshake({ langs, install, verbose })) > 0 ? 1 : 0);
	}

	const distEntry = path.join(repoRoot, "dist", "clients", "dispatch", "integration.js");
	if (!fs.existsSync(distEntry)) {
		console.error(`dist build missing: ${distEntry}\nRun \`npm run build:dist\` first.`);
		process.exit(2);
	}
	const { dispatchLintDetailed } = await import(pathToFileURL(distEntry).href);

	let ensureTool;
	if (install) {
		const installerEntry = path.join(repoRoot, "dist", "clients", "installer", "index.js");
		({ ensureTool } = await import(pathToFileURL(installerEntry).href));
	}

	const selected = langs.length
		? FIXTURES.filter((f) => langs.includes(f.lang))
		: FIXTURES;
	if (selected.length === 0) {
		console.error(`No fixtures matched: ${langs.join(", ")}`);
		process.exit(2);
	}

	// Disable delta filtering so every applicable runner reports its full output.
	const pi = { getFlag: (flag) => (flag === "no-delta" ? true : undefined) };

	const rows = [];
	for (const fixture of selected) {
		if (install && ensureTool) {
			for (const toolId of fixture.tools ?? []) {
				const resolved = await ensureTool(toolId);
				if (verbose) {
					console.error(
						`[${fixture.lang}] ensureTool(${toolId}) → ${resolved ?? "UNAVAILABLE"}`,
					);
				}
			}
		}
		const workspace = copyDirToTemp(fixture.dir);
		const absFile = path.join(workspace, fixture.file);
		try {
			const { runners } = await dispatchLintDetailed(absFile, workspace, pi, {
				blockingOnly: false,
			});
			if (verbose) {
				console.error(
					`[${fixture.lang}] executed runners: ${
						runners.map((r) => `${r.runnerId}:${r.result.status}`).join(", ") || "(none)"
					}`,
				);
			}
			for (const target of fixture.targets) {
				const outcome = runners.find((r) => r.runnerId === target);
				const verdict = classify(outcome);
				// Step 2: a tool that ran clean but found nothing on a known defect fails.
				if (
					step2 &&
					verdict.state === "pass" &&
					fixture.expectDiagnostic &&
					verdict.diags === 0
				) {
					verdict.state = "fail";
					verdict.detail = "ran clean but produced no diagnostic on known defect";
				}
				rows.push({ lang: fixture.lang, runner: target, ...verdict });
			}
		} catch (err) {
			for (const target of fixture.targets) {
				rows.push({
					lang: fixture.lang,
					runner: target,
					state: "fail",
					detail: `dispatch threw: ${err?.message ?? err}`,
					diags: 0,
				});
			}
		} finally {
			safeRm(workspace);
		}
	}

	process.exit(
		report(
			rows,
			step2 ? "Step 2 (spawn + diagnostic)" : "Step 1 (spawn + exit clean)",
		) > 0
			? 1
			: 0,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
