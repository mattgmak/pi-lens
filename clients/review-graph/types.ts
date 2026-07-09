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
	metadata?: Record<string, unknown>;
}

export interface ReviewGraphEdge {
	from: string;
	to: string;
	kind: ReviewGraphEdgeKind;
	metadata?: Record<string, unknown>;
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
