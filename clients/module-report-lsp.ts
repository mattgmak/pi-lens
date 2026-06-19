/**
 * Warm-only live-LSP enrichment for module_report (#256).
 *
 * This is intentionally split out from clients/module-report.ts because LSP is
 * the risky/optional tier: it can touch heavyweight language-server state while
 * the base report must remain a predictable tree-sitter + review-graph read
 * substitute. Invariants:
 *   - NEVER cold-spawn an LSP for module_report; use an already-warm client only.
 *   - Keep one wall-clock budget (default 3000ms) for the whole enrichment tier.
 *   - Bound fan-out so a module with many exports cannot flood a language server.
 */

import type { LSPLocation } from "./lsp/client.js";
import { uriToPath } from "./path-utils.js";
import type { ModuleSymbolUsedBy } from "./module-report.js";
import type { Symbol as ExtractedSymbol } from "./symbol-types.js";

let _lspBudgetMs: number | undefined;

/** Test seam: clear the memoized LSP budget so an env override takes effect. */
export function _resetModuleReportConfigForTests(): void {
	_lspBudgetMs = undefined;
}

function getLspBudgetMs(): number {
	if (_lspBudgetMs === undefined) {
		const raw = Number(process.env.PI_LENS_MODULE_REPORT_LSP_BUDGET_MS);
		// Default OFF (0) after the #256 OOM: the live-LSP tier is opt-in until the
		// warm-only/bounded path is validated in a real pi session. A finite >=0
		// value is honored verbatim (set 3000 to enable); anything else → 0.
		_lspBudgetMs = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
	}
	return _lspBudgetMs;
}

// Keep defaults conservative: module_report is a read substitute, not a bulk
// references tool. The global 3000ms budget is unchanged; these caps only bound
// concurrent/in-flight language-server work inside that budget.
const MAX_LSP_SYMBOLS = 20;
const LSP_SYMBOL_CONCURRENCY = 2;

// Kinds whose implementers are worth an LSP `implementation` probe.
const INTERFACE_LIKE_KINDS = new Set(["interface", "class", "type"]);

export interface ModuleReportLspEnrichment {
	source: "live-lsp" | "none";
	/** Reference data resolved from a live LSP server. */
	references: boolean;
	/** At least one symbol had implementers. */
	implementations: boolean;
	byName: Map<string, { usedBy?: ModuleSymbolUsedBy[]; hasImpl?: boolean }>;
}

const NO_LSP: ModuleReportLspEnrichment = {
	source: "none",
	references: false,
	implementations: false,
	byName: new Map(),
};

/**
 * LSP positions are 0-based and must land on the symbol's *identifier*. The
 * extractor records `column` at the declaration start (e.g. `export`/`function`),
 * so search the start line for the name from there to find the identifier column.
 */
function lspPosition(
	sym: ExtractedSymbol,
	lines: string[],
): { line: number; character: number } {
	const lineIdx = Math.max(0, sym.line - 1);
	const text = lines[lineIdx] ?? "";
	const fromCol = Math.max(0, (sym.column ?? 1) - 1);
	let character = text.indexOf(sym.name, fromCol);
	if (character < 0) character = text.indexOf(sym.name);
	if (character < 0) character = fromCol;
	return { line: lineIdx, character };
}

function lspLocationsToUsedBy(
	locs: LSPLocation[],
	cap: number,
): ModuleSymbolUsedBy[] {
	const out: ModuleSymbolUsedBy[] = [];
	const seen = new Set<string>();
	for (const loc of locs) {
		const file = loc.uri ? uriToPath(loc.uri) : "";
		if (!file) continue;
		const line = (loc.range?.start?.line ?? 0) + 1;
		const key = `${file}:${line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ file, symbol: "", line, relation: "references", provenance: "lsp" });
		if (out.length >= cap) break;
	}
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, Math.max(0, ms));
		timer.unref?.();
	});
}

async function withinRemaining<T>(
	promise: Promise<T>,
	deadlineAt: number,
): Promise<T | undefined> {
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) return undefined;
	return Promise.race([
		promise.catch(() => undefined),
		sleep(remaining).then(() => undefined),
	]);
}

/**
 * Best-effort live-LSP enrichment for exported symbols. This intentionally uses
 * only an already-running client (`getWarmClientForFile`) so module_report cannot
 * cold-start tsserver/pyright/etc. If no warm client exists, the caller gets the
 * base AST/review-graph report immediately.
 */
export async function enrichModuleReportWithWarmLsp(
	absPath: string,
	lines: string[],
	targets: ExtractedSymbol[],
	maxRefs: number,
	budgetMs = getLspBudgetMs(),
): Promise<ModuleReportLspEnrichment> {
	if (targets.length === 0 || budgetMs <= 0) return NO_LSP;

	let getLSPService: () => {
		getWarmClientForFile: (f: string) => Promise<{
			client: {
				references: (
					f: string,
					line: number,
					character: number,
					includeDeclaration?: boolean,
				) => Promise<LSPLocation[]>;
				implementation: (
					f: string,
					line: number,
					character: number,
				) => Promise<LSPLocation[]>;
			};
		} | undefined>;
	};
	try {
		({ getLSPService } = await import("./lsp/index.js"));
	} catch {
		return NO_LSP;
	}

	let warmClient: Awaited<ReturnType<ReturnType<typeof getLSPService>["getWarmClientForFile"]>>;
	try {
		warmClient = await getLSPService().getWarmClientForFile(absPath);
	} catch {
		return NO_LSP;
	}
	if (!warmClient) return NO_LSP;
	const client = warmClient.client;

	const deadlineAt = Date.now() + budgetMs;
	const byName = new Map<
		string,
		{ usedBy?: ModuleSymbolUsedBy[]; hasImpl?: boolean }
	>();
	let sawReferences = false;
	let sawImpl = false;
	let next = 0;
	const cappedTargets = targets.slice(0, MAX_LSP_SYMBOLS);

	async function enrichOne(sym: ExtractedSymbol): Promise<void> {
		if (Date.now() >= deadlineAt) return;
		const { line, character } = lspPosition(sym, lines);
		const refsPromise = withinRemaining(
			client.references(absPath, line, character, false),
			deadlineAt,
		).then((locs) => {
			if (!locs || Date.now() > deadlineAt) return;
			const usedBy = lspLocationsToUsedBy(locs, maxRefs);
			if (usedBy.length === 0) return;
			byName.set(sym.name, { ...byName.get(sym.name), usedBy });
			sawReferences = true;
		});

		const implPromise = INTERFACE_LIKE_KINDS.has(sym.kind)
			? withinRemaining(
					client.implementation(absPath, line, character),
					deadlineAt,
				).then((locs) => {
					if (!locs || locs.length === 0 || Date.now() > deadlineAt) return;
					byName.set(sym.name, { ...byName.get(sym.name), hasImpl: true });
					sawImpl = true;
				})
			: Promise.resolve();

		await Promise.allSettled([refsPromise, implPromise]);
	}

	async function worker(): Promise<void> {
		while (Date.now() < deadlineAt) {
			const index = next++;
			const sym = cappedTargets[index];
			if (!sym) return;
			await enrichOne(sym);
		}
	}

	const workers = Array.from(
		{ length: Math.min(LSP_SYMBOL_CONCURRENCY, cappedTargets.length) },
		() => worker(),
	);
	await Promise.allSettled(workers);

	return {
		source: sawReferences || sawImpl ? "live-lsp" : "none",
		references: sawReferences,
		implementations: sawImpl,
		byName,
	};
}
