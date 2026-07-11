/**
 * symbol_search pi tool (#348) — the entry point of the discovery funnel:
 * symbol_search finds ranked candidate files by identifier, module_report
 * explains one, read_symbol reads the exact body. Thin wrapper over the
 * existing symbolSearch() engine seam (clients/lens-engine.ts), mirroring the
 * MCP pilens_symbol_search tool with the same #517-slimmed payload.
 */

import * as path from "node:path";
import { Type } from "../clients/deps/typebox.js";
import { symbolSearch, type SymbolSearchResult } from "../clients/lens-engine.js";
import { baseName, compactRenderResult } from "./render-compact.js";

export function createSymbolSearchTool(getProjectRoot: () => string) {
	return {
		name: "symbol_search" as const,
		label: "Symbol Search",
		description:
			"Ranked identifier search over the persisted word index (BM25 + priors demoting tests/vendor/docs) — answers 'which files are most relevant to <query>' by identifier. First step of the discovery funnel: symbol_search finds candidates, module_report explains the file, read_symbol reads the body. Complements grep (raw substrings) and lsp_navigation (exact references). Each hit's startLine/endLine mark its best-matching line (offset=startLine, limit=endLine-startLine+1 for a one-line peek); use module_report on `file` for the real outline. Returns available:false with a retry hint if the index isn't built yet — it self-builds in the background (never blocks this call).",
		promptSnippet: "Ranked identifier search — find relevant files by name/usage",
		renderResult: compactRenderResult<{
			available?: boolean;
			query?: string;
			count?: number;
			hint?: string;
		}>(({ details, isError }) => {
			if (isError || details?.available === false) {
				return `symbol_search "${details?.query ?? ""}" — unavailable${details?.hint ? `: ${details.hint}` : ""}`;
			}
			return `symbol_search "${details?.query ?? ""}"  ${details?.count ?? 0} file(s)`;
		}),
		parameters: Type.Object({
			query: Type.String({
				description: "Identifier-ish query, e.g. 'authenticate user'.",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Max files to return (default 20).",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { query: string; limit?: number },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const cwd = getProjectRoot() || ctx.cwd || ".";
			let result: SymbolSearchResult;
			try {
				result = symbolSearch(params.query, cwd, params.limit);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Symbol search failed for "${params.query}": ${message}`,
						},
					],
					isError: true,
					details: { available: false, query: params.query },
				};
			}
			if (!result.available) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								result.hint ??
								"No word index for this workspace yet — retry shortly.",
						},
					],
					isError: true,
					details: {
						available: false,
						query: result.query,
						hint: result.hint,
					},
				};
			}
			if (result.results.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: `No files matched "${params.query}".` },
					],
					details: { available: true, query: result.query, count: 0 },
				};
			}
			const lines = [
				`Top ${result.results.length} file(s) for "${result.query}":`,
				...result.results.map(
					(hit, i) =>
						`  ${i + 1}. ${path.relative(cwd, hit.file)} ` +
						`(score ${hit.score.toFixed(2)}, ${hit.hits} hit(s), line ${hit.startLine})`,
				),
			];
			// Compact (unindented) JSON payload, matching module_report/read_symbol
			// (#517): path relative-to-cwd once per hit, no per-hit `read` block —
			// startLine/endLine already derive offset/limit for a one-line peek.
			const payload = {
				available: true,
				query: result.query,
				results: result.results.map((hit) => ({
					file: path.relative(cwd, hit.file),
					score: hit.score,
					hits: hit.hits,
					startLine: hit.startLine,
					endLine: hit.endLine,
				})),
			};
			return {
				content: [
					{ type: "text" as const, text: `${lines.join("\n")}\n\n${JSON.stringify(payload)}` },
				],
				details: {
					available: true,
					query: result.query,
					count: result.results.length,
				},
			};
		},
	};
}

// Re-exported so tests importing from this module can reach baseName without
// a second import path.
export { baseName };
