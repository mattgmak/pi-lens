# codedb-inspired pi-lens implementation plan

## Goal

Adopt the useful parts of codedb's architecture that fit pi-lens: fast persistent project intelligence, consistent snapshot/version semantics, cheap reverse-dependency queries, and safer agent edits. Do **not** replace LSP or turn pi-lens into a separate required daemon.

## Principles

- Keep pi-lens hook-driven and lightweight.
- Preserve LSP as the source of truth for type-aware diagnostics.
- Prefer persisted project snapshots over repeated startup scans.
- Give reports a project/file sequence so agents can detect stale context.
- Make reverse dependencies and recently changed files cheap first-class queries.
- Keep expensive indexes lazy and opt-in.

## Phase 1 — Project intelligence snapshot

Status: **foundation implemented**. `clients/project-snapshot.ts` now saves/loads a versioned, seq-stamped project snapshot, hydrates cached exports and project rules at session start, and refreshes the snapshot when project rules, ast-grep exports, or project-index metadata are available.

Create a single persisted snapshot that consolidates the data pi-lens already computes in separate places.

### New file

`clients/project-snapshot.ts`

### Snapshot shape

```ts
export interface ProjectSnapshot {
  version: 1;
  projectRoot: string;
  generatedAt: string;
  seq: number;
  files: Record<string, ProjectSnapshotFile>;
  symbols: Record<string, ProjectSnapshotSymbol[]>;
  reverseDeps: Record<string, string[]>;
  ruleScan?: {
    hasCustomRules: boolean;
    rules: unknown[];
  };
}

export interface ProjectSnapshotFile {
  path: string;
  mtimeMs: number;
  size: number;
  hash?: string;
  language?: string;
  lineCount?: number;
  imports?: string[];
  symbolCount?: number;
  lastSeq: number;
}

export interface ProjectSnapshotSymbol {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}
```

### Storage

- Latest snapshot:
  - `.pi-lens/cache/project-snapshot.json`
- Metadata:
  - `.pi-lens/cache/project-snapshot.meta.json`

Use `CacheManager.writeCache("project-snapshot", ...)`.

### Initial scope

Consolidate existing cached data:

- project file inventory
- cached exports / symbol index
- review graph dependency edges
- reverse dependency map
- project rule scan summary

Do not initially add full-text/trigram indexing.

### Acceptance criteria

- Session start can load snapshot if fresh and compatible.
- Snapshot invalidates on cache version mismatch.
- Snapshot skips ignored/generated/vendor files using existing project scan policy.
- Snapshot build is guarded by existing startup-scan in-flight protection.

## Phase 2 — Monotonic project/file sequence

Status: **foundation implemented**. `RuntimeCoordinator` now maintains project/file sequence counters, seeds them from the persisted change log at session start, and exposes `projectSeq`, `turnStartProjectSeq`, `bumpFileSeq()`, and `getFileSeq()`.

Add codedb-style sequence numbers to make reports and edits staleness-aware.

### Runtime state

Add to `RuntimeCoordinator`:

```ts
private _projectSeq = 0;
private _fileSeq = new Map<string, number>();

bumpFileSeq(filePath: string): number;
getFileSeq(filePath: string): number;
get projectSeq(): number;
```

### When to bump

Bump on every pi-observed disk mutation:

- successful write/edit tool result
- pi-lens immediate autofix
- pi-lens deferred format
- partial apply
- future project autofix
- applied LSP workspace edit

### Report integration

Add sequence metadata to:

- `actionable-warnings.json`
- `code-quality-warnings.json`
- `turn-end-findings-last.json`
- future project snapshot

Example:

```json
{
  "projectSeqStart": 120,
  "projectSeqEnd": 126,
  "files": [
    { "filePath": "src/a.ts", "fileSeq": 33 }
  ]
}
```

### Acceptance criteria

- Agent-facing reports can state whether they are latest-turn reports.
- Agent-end autofix can reject stale actionable-warning reports when project seq advanced unexpectedly.

## Phase 3 — Changes-since API/cache

Status: **foundation implemented**. `clients/project-changes.ts` now appends `<project-data-dir>/change-log.jsonl`, reads the latest project/file sequence state, and exposes `readChangesSince()`.

Create a cheap query equivalent to codedb `changesSince(seq)`.

### New runtime/cache data

Append-only project change log:

- `.pi-lens/change-log.jsonl`

Entry:

```ts
interface ProjectChangeEntry {
  seq: number;
  timestamp: string;
  sessionId: string;
  turnIndex: number;
  source: "agent-write" | "agent-edit" | "format" | "autofix" | "partial-apply" | "lsp-edit" | "external";
  filePath: string;
  fileSeq: number;
  changedRange?: { start: number; end: number };
}
```

### API/helpers

`clients/project-changes.ts`

```ts
appendProjectChange(cwd, entry)
readChangesSince(cwd, seq, maxEntries?)
```

### Use cases

- Session-start guidance can say “last session modified these files.”
- Reports can link to exact changes since the agent's last read.
- Future tools can expose this as `lens_changes`.

## Phase 4 — First-class reverse dependency index

Status: **foundation implemented**. `clients/reverse-deps.ts` can build `file -> imports` and `file -> importedBy` indexes from the existing review graph, persist them into the project snapshot, reload fresh snapshot-backed indexes, and answer bounded reverse-dependency / affected-file queries. Cascade graph builds now opportunistically refresh the snapshot reverse-dependency section and merge fresh cached reverse-dependency neighbors into cascade neighbor selection.

Make reverse dependency lookup a cheap primitive instead of only a cascade byproduct.

### Build source

Use existing review graph builder/import extraction.

Persist:

- `file -> imports`
- `file -> importedBy`

inside `project-snapshot.json` or separate cache:

- `.pi-lens/cache/reverse-deps.json`

### API

`clients/reverse-deps.ts`

```ts
getReverseDeps(cwd, filePath): string[]
getAffectedFiles(cwd, filePath, depth = 1): string[]
```

### Integrations

- `computeCascadeForFile`
- turn-end test suggestions
- session-start guidance
- future code-quality report context

### Acceptance criteria

- Reverse deps query avoids rebuilding full graph on common path.
- Cache updates incrementally for edited files where possible.

## Phase 5 — Hot files and session friction summary

Borrow codedb's `hot` idea, but make it agent-oriented.

### New report/cache

`.pi-lens/cache/hot-files.json`

Tracks:

- files changed this session
- files changed recently across sessions
- files with repeated read-guard blocks
- files with repeated diagnostics
- files touched by autofix/format

### Agent-facing use

Session-start guidance can include:

```text
Recently active files:
  clients/read-guard-tool-lines.ts — edited 4x, 2 quality warnings
  index.ts — formatted/autofixed last session
```

Keep this concise and advisory-only.

## Phase 6 — Internal edit substrate to reduce failed edits

Status: **not implemented**. This phase should be an internal pi-lens mutation substrate, not a new exposed `lens_edit` tool.

### Goal

Reduce failed edits by giving pi-lens-owned mutations a range + sequence/hash validated write path that complements the existing native edit lifecycle:

```text
Native agent edit/write path:
read expansion → read guard → oldText autopatch → native edit → tool_result pipeline

pi-lens-owned mutation path:
seq/hash/range validation → atomic apply → read-guard stamp → seq/change-log → normal post-edit pipeline
```

Keep the native `edit` tool path intact. Read expansion, read-guard preflight, oldText autopatch, and exact-text matching remain the first line of defense for model-authored edits. The new helper should be used where pi-lens itself already mutates disk or could safely do so after read-guard has proven a subset of changes.

### Why this limits failed edits

Recent read-guard telemetry showed common failures:

- `oldtext_duplicate` — exact `oldText` appears at multiple locations. A range-backed internal edit can target the specific resolved line range instead of matching ambiguous text globally.
- `oldtext_not_found` — file drift or copied text mismatch. A seq/hash check can fail early with a clear stale-file reason and current seq/hash instead of retrying fragile text.
- `file_modified` / snapshot `mismatch` — file changed after read or partial apply. `expectedFileSeq`/`expectedHash` makes the rejection explicit and actionable: re-read before editing.
- `out_of_range` — line drift outside recorded read ranges. The helper can require explicit range coverage or consume ranges already proven safe by read-guard resolution.

### Internal API sketch

Use an internal helper, likely `clients/lens-edit.ts` or similar:

```ts
applyInternalEdit({
  cwd,
  runtime,
  cacheManager,
  filePath,
  source: "partial-apply" | "lsp-edit" | "autofix",
  expectedFileSeq?,
  expectedHash?,
  edits: [
    {
      startLine,
      endLine,
      newText,
      expectedText?, // optional extra guard for the exact span
    }
  ],
  runPostEditPipeline?,
})
```

Return structured results:

```ts
type ApplyInternalEditResult =
  | { ok: true; changed: boolean; projectSeq: number; fileSeq: number }
  | {
      ok: false;
      reason:
        | "stale_seq"
        | "hash_mismatch"
        | "overlap"
        | "expected_text_mismatch"
        | "out_of_read_range";
      currentFileSeq?: number;
      currentHash?: string;
      suggestedAction: "re-read";
    };
```

### Safety

- Reject stale `expectedFileSeq` when provided.
- Reject stale `expectedHash` when provided.
- Reject overlapping ranges.
- Optionally verify `expectedText` against the exact range being replaced.
- Apply edits bottom-up to avoid line drift.
- Prefer atomic write via temp file + rename where possible.
- Record project change with the correct source.
- Bump file/project seq exactly once per changed file.
- Record read-guard write stamp.
- Add modified ranges/import-change metadata to `CacheManager`.
- Route through `handleToolResult`/normal post-edit pipeline when requested.
- Never silently guess or widen stale ranges.

### Initial integration order

1. **Partial apply** — first target. Read-guard already resolves which exact oldText replacements are safe; use the helper to apply only those proven replacements with range/seq bookkeeping and normal post-edit routing.
2. **LSP workspace edits** — share the same bottom-up/atomic/range application core, then add seq/change-log/read-guard bookkeeping for applied workspace edits.
3. **Actionable autofix** — after stale report checks pass, apply selected LSP quickfix edits through the same internal substrate.
4. **Future project autofix/manual flows** — only opt-in, never default hook-path project-wide mutation.

### Non-goals

- Do not expose a public `lens_edit` tool initially.
- Do not bypass read guard for normal agent edits.
- Do not replace oldText autopatch.
- Do not silently apply broad/project-wide edits.
- Do not downgrade safety to make stale edits succeed.

### Acceptance criteria

- Partial apply uses this internal path for resolved replacements.
- Failed internal edits return stale seq/hash/range details and recommend re-read.
- LSP workspace edits can reuse the same atomic/range application core.
- Actionable autofix can reuse the same bookkeeping after report freshness validation.
- Normal native `edit` behavior, read expansion, read-guard checks, and oldText autopatches remain unchanged.

## Phase 7 — Lazy heavy indexes

Do not eagerly build everything at session start.

### Keep eager/lightweight

- file inventory
- shallow outlines/symbols
- reverse deps if cache fresh
- project rules scan summary

### Keep lazy/background

- jscpd
- knip
- full review graph rebuild
- expensive structural similarity/project index
- future full-text/trigram index

### Triggering

- hook paths request only what they need
- turn-end can refresh if needed
- commands can force rebuild

## Phase 8 — Optional search index experiment

codedb's trigram/word index is impressive, but pi-lens already has ripgrep/ast-grep/LSP. Treat this as optional.

### Candidate feature

A lightweight word/symbol lookup cache for agent guidance:

- exact identifier lookup
- symbol name lookup
- maybe simple substring search

### Avoid initially

- full custom trigram engine
- replacing ripgrep
- parsing every language deeply

## Things not to copy directly

- Required HTTP daemon.
- Replacing LSP with custom parsers.
- Polling watcher as the main source of truth; pi hooks already provide write/edit lifecycle events.
- Cloud/remote repo queries unless explicitly requested later.

## Suggested implementation order

1. ~~Project/file sequence tracking.~~ Done.
2. ~~Append-only change log.~~ Done.
3. ~~Add seq metadata to actionable/code-quality reports.~~ Done.
4. ~~Project snapshot cache consolidating existing indexes.~~ Foundation done.
5. ~~Reverse dependency cache/query helper.~~ Foundation done.
6. Hot files report.
7. Native versioned edit helper.
8. Optional search index experiment.

## Tests

Add tests for:

- sequence bumps on write/edit/format/autofix/partial apply
- stale report detection by seq
- changesSince filtering and max cap
- snapshot load/save/version invalidation
- reverse dependency lookup from cached graph — foundation covered
- hot files aggregation
- native edit stale-seq rejection
- native edit post-pipeline routing

## Open questions

- Should project sequence be persisted across sessions or reset per session? Prefer persisted per project.
- Should file hashes be cheap line hashes, full content hashes, or mtime+size initially? Prefer mtime+size initially, full hash only for touched files.
- Should a future `lens_changes` tool be exposed to agents, or only used internally for guidance?
- Native edit helper decision: keep it internal initially. It should complement read expansion/read-guard/autopatch by powering pi-lens-owned mutations, not replace the native agent `edit` path or be exposed as a model-facing tool.
