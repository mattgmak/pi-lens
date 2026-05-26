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

## Phase 6 — Safer native edit path

codedb's line-range edit model is a good direction for pi-lens.

### Goal

Create a pi-lens-owned edit helper that uses explicit file version/hash/range checks and automatically runs post-edit pipeline.

### Possible tool/API

`lens_edit` or internal helper first:

```ts
applyLensEdit({
  filePath,
  expectedFileSeq,
  expectedHash?,
  edits: [
    { startLine, endLine, newText }
  ]
})
```

### Safety

- rejects stale `expectedFileSeq`
- rejects overlapping ranges
- applies bottom-up
- atomic write via temp file + rename where possible
- records project change
- bumps file/project seq
- records read-guard write stamp
- runs `handleToolResult`/pipeline

### Acceptance criteria

- Partial apply uses this path eventually.
- LSP workspace edits can reuse the same bookkeeping.
- Agent-facing edit failures include current seq/hash and suggested re-read.

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
5. Reverse dependency cache/query helper.
6. Hot files report.
7. Native versioned edit helper.
8. Optional search index experiment.

## Tests

Add tests for:

- sequence bumps on write/edit/format/autofix/partial apply
- stale report detection by seq
- changesSince filtering and max cap
- snapshot load/save/version invalidation
- reverse dependency lookup from cached graph
- hot files aggregation
- native edit stale-seq rejection
- native edit post-pipeline routing

## Open questions

- Should project sequence be persisted across sessions or reset per session? Prefer persisted per project.
- Should file hashes be cheap line hashes, full content hashes, or mtime+size initially? Prefer mtime+size initially, full hash only for touched files.
- Should a future `lens_changes` tool be exposed to agents, or only used internally for guidance?
- Should native edit be an exposed pi tool or just an internal helper used by read-guard/autofix/LSP edits?
