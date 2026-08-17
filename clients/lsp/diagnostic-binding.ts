import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { PathKeyedMap } from "../path-keyed-map.js";
import { normalizeEphemeralMapKey } from "../path-utils.js";

/**
 * #1095: bind LSP diagnostics to the document CONTENT they were computed
 * against, instead of inferring staleness purely from mtime/TTL proxies.
 *
 * A `publishDiagnostics` notification carries an optional `version` (the
 * document version the diagnostics apply to). pi-lens already owns the
 * didOpen/didChange version counter and the exact text it sent at each
 * version, so at SEND time it can fingerprint that text and, when the server
 * echoes a `version`, bind the stored diagnostics to that fingerprint. A
 * consumer can then ask "were these diagnostics computed against what's on
 * disk NOW?" by comparing the fingerprint to the current file bytes — a real
 * content check rather than an mtime proxy.
 */

/**
 * true  → the diagnostics' fingerprint matches the current disk bytes.
 * false → it demonstrably does NOT (the server's view diverged from disk).
 * "unknown" → cannot be determined (server never reported a version, so no
 *   fingerprint was captured; or the file could not be stat'd/read). "unknown"
 *   is the honest #533 fallback — never rendered as false-clean OR false-live —
 *   and preserves EXACTLY the pre-#1095 behavior for servers that never bind.
 */
export type BoundToCurrentDisk = boolean | "unknown";

/**
 * The stored half of a binding: what a per-file diagnostics entry was computed
 * against. Captured at publish time on the owning client (see
 * `LSPClientState.diagnosticBindings`). Both fields are absent for a version-
 * less publish; `contentHash` is present only when a server-reported version
 * matched the client's last-sent version for that document.
 */
export interface StoredDiagnosticBinding {
	/** The `publishDiagnostics.version` the diagnostics were computed against. */
	version?: number;
	/** sha256 of the EXACT didOpen/didChange payload text for that version. */
	contentHash?: string;
}

/**
 * The read-time binding surfaced to consumers: the stored half plus the lazily
 * computed disk verdict.
 *
 * SIDE-CHANNEL CARRIAGE CONTRACT (#1108 shape-5 — copy-loss risk). Two producers
 * on `clients/lsp/index.ts` surface a binding:
 *   - `touchFile` returns a `TouchFileResult` WRAPPER (`{ diags, confirmation,
 *     inconclusive, binding }`, below) — the #1179 structural fix. These flags are
 *     EXPLICIT ENUMERABLE fields on that wrapper, so a `[...]`/`.map`/`.filter`/
 *     `structuredClone`/`JSON` copy of the DIAGNOSTICS (`.diags`) can no longer
 *     drop them: the copy operates on `.diags`, the flags stay on the wrapper.
 *   - `getAllDiagnostics` still attaches `binding` as a lazy, disk-verifying
 *     NON-enumerable getter on each Map entry — deliberately NOT migrated to an
 *     enumerable field, because enumerable would make an incidental spread/serialize
 *     eagerly trigger the per-entry disk stat+hash (a stat storm the cascade's
 *     TTL-gated read exists to avoid). That getter therefore KEEPS the read-off-
 *     original contract:
 *       - READ IT OFF THE ORIGINAL producer entry, never off a derived copy. Any
 *         `{...entry}` / `structuredClone` / `JSON.parse(JSON.stringify(...))`
 *         between the producer and the read SILENTLY DROPS the getter — the consumer
 *         then reads `undefined` (indistinguishable from "unknown") and skips the
 *         #1092 staleness demotion. This is the class that bit as #1094
 *         (`inconclusive`) and #1096 (`binding`); the cascade reads the binding off
 *         the original `entry` BEFORE any copy for exactly this reason
 *         (`clients/dispatch/integration.ts` `readBoundToCurrentDisk`).
 *   - IF A FLAG MUST CROSS A SERIALIZATION BOUNDARY (the warm-attach IPC socket, a
 *     JSON round-trip), re-surface it as an EXPLICIT enumerable field on the
 *     transport DTO — no side-channel (enumerable or not) survives `JSON.stringify`
 *     of a `.diags` array. See `clients/warm-attach.ts`/`clients/mcp/ipc.ts`, which
 *     carry `inconclusive` as an enumerable response field for exactly this reason.
 */
export interface DiagnosticBinding extends StoredDiagnosticBinding {
	boundToCurrentDisk: BoundToCurrentDisk;
}

/**
 * #1179 (shape-5 structural fix): the confirmed shape a diagnostics-collecting
 * `touchFile` resolves to. The diagnostics array plus the two former
 * NON-enumerable side-channel flags (`inconclusive` #570/#1093, `binding` #1095)
 * promoted to EXPLICIT ENUMERABLE fields on a wrapper, so the copy-loss class of
 * #1094/#1096 is impossible BY CONSTRUCTION: a copy of the diagnostics operates on
 * `.diags` and never touches the flags on the wrapper.
 *
 * `diags` is always present (empty array when nothing was collected). `inconclusive`
 * is present-and-true only for a genuinely unconfirmed collect (the notify write
 * and/or diagnostics wait lapsed its deadline). `confirmation` is present only when
 * this touch completed its configured diagnostics/confirmation policy — `"confirmed"`
 * for every spawned server, or (#1470) `"partial"` when an auxiliary's push wait was
 * cut off by the aux grace timer and `unconfirmedServerIds` names it. A partial touch
 * is deliberately NOT `inconclusive`: the primary answered and its findings stand;
 * only the claim of full coverage is withdrawn. It is required
 * before treating an empty result from a known silent-on-clean server as clean, but is
 * not a substitute for a consumer's stricter scope-specific fallback — notably, an
 * all-scope classic TypeScript touch still needs the tool's synchronous tsserver check.
 * `binding` is present only for a collecting touch that composed one (absent →
 * "unknown", the honest #533 fall-through).
 *
 * A touch that SHORT-CIRCUITS resolves to `{ diags: [] }` with no confirmation
 * metadata — that is `shouldSkipTouch`, which requires `waitForDiagnostics ===
 * false`, i.e. a non-collecting (`diagnostics: "none"`) touch whose content every
 * spawned server already has. A debounced COLLECTING touch is a different thing
 * and does NOT short-circuit: the notify is skipped for the servers that already
 * hold the content, but the diagnostics wait still runs and the touch can resolve
 * `confirmation: "confirmed"` on its own evidence. That is sound because the
 * debounce entry is per-server and recorded only when that server's write
 * actually landed (#1253/#743) — a skipped notify therefore means "this server
 * demonstrably has this content", which is exactly the premise the silent-clean
 * gates need.
 */
export interface TouchFileResult {
	diags: import("./client.js").LSPDiagnostic[];
	confirmation?: "confirmed" | "partial";
	inconclusive?: boolean;
	/**
	 * #1470: server ids this touch carries NO evidence for. Populated (and
	 * `confirmation` narrowed to `"partial"`) when an auxiliary's push wait was
	 * cut off by the aux grace timer — R8/#714's `auxCutOffServerIds`. Absent
	 * when every spawned server got to answer for itself.
	 */
	unconfirmedServerIds?: string[];
	binding?: DiagnosticBinding;
}

/**
 * #1470: the single source of truth for "which servers did this touch NOT hear
 * from". Read this instead of comparing `confirmation` to a string literal — a
 * consumer that tests `confirmation === "confirmed"` is correct only by accident
 * (it happens to fail closed for `"partial"`), and one that tests `!inconclusive`
 * is outright wrong, because a partially-confirmed touch is deliberately NOT
 * inconclusive: the primary's answer is still trustworthy and must survive.
 */
export function touchCoverageGap(
	result: TouchFileResult | undefined,
): readonly string[] {
	return result?.unconfirmedServerIds ?? [];
}

/**
 * #1470: did this touch complete its configured confirmation policy at all —
 * `"confirmed"` (for every spawned server) or `"partial"` (for every server
 * except the named cut-off auxiliaries)?
 *
 * This is deliberately NOT `confirmation === "confirmed"`. A consumer asking
 * "did the PRIMARY confirm?" must answer yes for a partial touch: `partial`
 * implies neither the notify write nor the diagnostics wait lapsed, so the
 * silent-clean gates ran to completion exactly as they do for a full
 * confirmation. Reading `=== "confirmed"` there looks safely fail-closed but
 * reports "the language server could not confirm clean" when the truth is "the
 * language server confirmed clean and a scanner was cut off" — the same overclaim
 * pointing the other way. Pair this with {@link touchCoverageGap}, which names
 * what the touch does not speak for.
 */
export function touchCompletedConfirmationPolicy(
	result: TouchFileResult | undefined,
): boolean {
	return result?.confirmation !== undefined;
}

/**
 * Fingerprint the EXACT text handed to didOpen/didChange. sha256 over the raw
 * string — no normalization — so the disk comparison (which reads the file with
 * the SAME raw `utf-8` transform pi-lens builds LSP payloads with) round-trips
 * CRLF and BOM bytes identically. See `createDiskBindingCache`.
 */
export function hashDiagnosticContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Compose the merged `boundToCurrentDisk` across every client contributing to a
 * merged diagnostics result (primary + auxiliaries). The merged set is only as
 * trustworthy as its least-bound contributor:
 *   - ANY contributor demonstrably mismatches disk        → false
 *   - otherwise, all contributors are "unknown" (or none) → "unknown"
 *   - otherwise (≥1 bound, none mismatched)               → true
 * Unknowns never block a `true`: a version-less auxiliary alongside a bound
 * primary must not erase the primary's binding, only a real mismatch does.
 */
export function composeBoundToCurrentDisk(
	values: readonly BoundToCurrentDisk[],
): BoundToCurrentDisk {
	if (values.some((v) => v === false)) return false;
	if (values.length === 0 || values.every((v) => v === "unknown")) {
		return "unknown";
	}
	return true;
}

/** One-word summary of a binding verdict for latency/observability logs. */
export function bindingStateLabel(
	value: BoundToCurrentDisk,
): "bound" | "mismatch" | "unknown" {
	if (value === true) return "bound";
	if (value === false) return "mismatch";
	return "unknown";
}

/**
 * Lazily verify a stored binding against current disk, memoizing the disk
 * fingerprint per (file, mtime) so repeated reads within a sweep don't re-hash
 * unchanged files. Cheapness contract (#1095): stat the file first and only
 * read+hash when the mtime differs from the memoized entry.
 *
 * READ-TRANSFORM SYMMETRY (the CRLF/BOM invariant): pi-lens builds every LSP
 * didOpen/didChange payload from `fs.readFile(path, "utf-8")` (raw UTF-8 — no
 * BOM strip, no EOL normalization). This verifier reads disk with the identical
 * `readFileSync(path, "utf-8")` so a Windows CRLF(+BOM) file whose bytes are
 * unchanged fingerprints identically and binds `true`. Any divergence here
 * would make every Windows file spuriously mismatch.
 */
export interface DiskBindingCache {
	boundToCurrentDisk(
		filePath: string,
		stored: StoredDiagnosticBinding,
	): BoundToCurrentDisk;
}

/**
 * Bound on the per-(file,mtime) disk-fingerprint memo. The memo grows by one
 * entry per distinct tracked file; a full clear on overflow (rather than an LRU)
 * is fine because each entry is a pure, cheaply-recomputed derivation of disk
 * bytes — the worst case after a clear is one extra re-hash per file. Keeps the
 * map from growing unbounded across a long-lived session.
 */
const DISK_BINDING_MEMO_MAX = 4096;

export function createDiskBindingCache(): DiskBindingCache {
	// #1025: key through PathKeyedMap + normalizeEphemeralMapKey so two forms of
	// the same path (`SUB\a.ts` vs `sub/a.ts`) can't produce a duplicate memo or a
	// false miss. Ephemeral (slash-fold + win32-lowercase, no realpath I/O) — the
	// keys are file paths this process is already stat'ing on the hot read path.
	const diskHashByPath = new PathKeyedMap<{ mtimeMs: number; hash: string }>(
		normalizeEphemeralMapKey,
	);
	return {
		boundToCurrentDisk(filePath, stored) {
			// No fingerprint captured (version-less server) → unknown, never false.
			if (stored.contentHash === undefined) return "unknown";
			let mtimeMs: number;
			try {
				mtimeMs = fs.statSync(filePath).mtimeMs;
			} catch {
				// Can't stat (deleted/unreadable): can't disprove the binding either,
				// so stay honest — "unknown", never a manufactured false.
				return "unknown";
			}
			let cached = diskHashByPath.get(filePath);
			if (!cached || cached.mtimeMs !== mtimeMs) {
				let diskHash: string;
				try {
					diskHash = hashDiagnosticContent(fs.readFileSync(filePath, "utf-8"));
				} catch {
					return "unknown";
				}
				cached = { mtimeMs, hash: diskHash };
				if (diskHashByPath.size >= DISK_BINDING_MEMO_MAX) {
					diskHashByPath.clear();
				}
				diskHashByPath.set(filePath, cached);
			}
			return cached.hash === stored.contentHash;
		},
	};
}
