export type ReviewGraphNodeKind = "file" | "symbol" | "module" | "external";
export type ReviewGraphEdgeKind =
	| "contains"
	| "defines"
	| "imports"
	| "calls"
	| "references";

export interface ReviewGraphNode {
	id: string;
	kind: ReviewGraphNodeKind;
	language: string;
	filePath?: string;
	symbolName?: string;
	symbolKind?: string;
	exported?: boolean;
	/**
	 * Dotted owner-qualified display name (e.g. `UserService.run`) — refs #655
	 * phase 2. Set only when a nearest strictly-containing declaration (class/
	 * interface/struct/etc, computed via `review-graph/qualified-name.ts`'s
	 * `findOwnerName`, the SAME containment algorithm module-report.ts's outline
	 * nesting uses) was found for this symbol; top-level symbols have none and
	 * omit the field. `module-report.ts` renders this (falling back to
	 * `symbolName`) in `usedBy`/`blastRadius`, and it MUST stay a valid dotted
	 * input to `read_symbol`'s own `Class.method` qualifier parsing
	 * (`resolveQualifiedMatch`) — both derive from the same "smallest
	 * containing declaration" notion of ownership, so a name rendered here
	 * always resolves correctly there.
	 */
	qualifiedName?: string;
	metadata?: Record<string, unknown>;
}

export interface ReviewGraphEdge {
	from: string;
	to: string;
	kind: ReviewGraphEdgeKind;
	metadata?: Record<string, unknown>;
	/**
	 * Resolution confidence for a `calls`/`references` edge. A callee/reference
	 * is initially matched by bare name only (the extractor sees no import/type
	 * info) — `"name-only"` means it stayed that way: 0 or 2+ same-named
	 * candidates existed graph-wide (or a same-file import/receiver-type hint
	 * failed to narrow it), so `edge.to` may point at an unresolved placeholder
	 * node or, ambiguously, could be the wrong same-named symbol.
	 *
	 * Four increasingly-specific non-"name-only" tiers (refs #655 phase 2,
	 * narrow slice of its full `resolution` enum — no `invocation` tracking):
	 * - `"exact"`: exactly one same-named real symbol existed anywhere in the
	 *   graph at resolution time — provably unambiguous by uniqueness alone.
	 * - `"import"`: the calling file's own import statements name exactly which
	 *   file the bare-name callee comes from (e.g. `import { run } from
	 *   "./service.js"`), narrowing the candidate set to that file BEFORE the
	 *   graph-wide uniqueness check; resolved when that file has exactly one
	 *   same-named symbol. Currently computed for jsts only (see builder.ts's
	 *   `addJsTsFile` — the only ingestion path with import-specifier names
	 *   already extracted per call site).
	 * - `"receiver-type"`: a member-expression call (`obj.method()`) whose
	 *   receiver's class is determinable from the SAME file's tree-sitter parse
	 *   (a `new ClassName()` assignment or a typed parameter/variable
	 *   declaration immediately visible in the same function) resolves directly
	 *   to that class's same-named method — bypassing bare-name ambiguity
	 *   entirely. jsts-only for this slice (see builder.ts's
	 *   `resolveReceiverType`); cross-module receivers, generics, and dynamic
	 *   dispatch are conservatively left `"name-only"` rather than guessed.
	 *
	 * None of these three type-check or scope-resolve like a real compiler —
	 * they narrow candidates structurally and only ever upgrade past
	 * `"name-only"` when the match is unambiguous by construction; an
	 * under-determined case always stays `"name-only"`, never a wrong
	 * upgrade. Undefined for edge kinds where resolution confidence doesn't
	 * apply (`imports`/`contains`/`defines`) and for `calls` edges to a
	 * definite external target (`callee.includes(".")` with no in-project
	 * receiver hint, in builder.ts).
	 */
	resolution?: "exact" | "import" | "receiver-type" | "name-only";
}

export interface ReviewGraph {
	version: string;
	builtAt: string;
	nodes: Map<string, ReviewGraphNode>;
	edges: ReviewGraphEdge[];
	edgesByFrom: Map<string, ReviewGraphEdge[]>;
	edgesByTo: Map<string, ReviewGraphEdge[]>;
	fileNodes: Map<string, string>;
	symbolNodesByFile: Map<string, string[]>;
	changedSymbolsByFile: Map<string, string[]>;
	/**
	 * #459: process-local monotonic stamp identifying the graph CONTENT this
	 * instance was built from. Two returned graphs share a generation iff no
	 * graph-mutating build happened between them, so caches of graph-derived
	 * data (e.g. the reverse-dependency index) key invalidation off this — it
	 * travels with the instance, unlike the global last-build-info slot, which
	 * overlapping deferred cascades can clobber (#450). Absent on graphs from
	 * paths that never reuse (mode "skipped") ⇒ derived caches must rebuild.
	 */
	buildGeneration?: number;
}

export interface ImpactCascadeResult {
	filePath: string;
	changedSymbols: string[];
	directImporters: string[];
	directCallers: string[];
	neighborFiles: string[];
	riskFlags: string[];
}
