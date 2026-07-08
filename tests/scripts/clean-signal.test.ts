/**
 * Tests for the pure helpers behind scripts/probe-clean-signal.mjs (#460):
 *   - scripts/lib/clean-signal.mjs  — classifyCleanBehavior, the PHASE-AWARE
 *     4-way classifier (2 publishes-versioned / 2* publishes-unversioned /
 *     3 silent / unknown). The phase dimension matters: a server that published
 *     only on the dirty touch and went silent on clean transitions (typescript —
 *     the true budget-wait case) must NOT be conflated with one that actively
 *     re-publishes version-lessly on clean transitions (opengrep — early-returns
 *     the wait at runtime).
 *   - scripts/lib/md-matrix.mjs     — the partial-doc MERGE guard (#390): a run
 *     that couldn't measure a server must NOT drop or blank its row.
 *
 * These are the classifier + merge logic the nightly relies on; spawning a server
 * is out of scope for a unit test (mirrors the repo pattern of testing script
 * helpers, not the scripts, per tests/scripts/changelog.test.ts).
 */

import { describe, expect, it } from "vitest";
import { classifyCleanBehavior } from "../../scripts/lib/clean-signal.mjs";
import {
  mergeRows,
  mergeSrc,
  parseTable,
  replaceTable,
} from "../../scripts/lib/md-matrix.mjs";

describe("classifyCleanBehavior (phase-aware 4-way)", () => {
  it("classifies a versioned clean-transition publisher as publishes-versioned (tier 2)", () => {
    // ast-grep-shaped: re-publishes WITH a version on a clean transition.
    const v = classifyCleanBehavior({
      dirtyPublishes: 2,
      dirtyVersioned: 2,
      cleanTransitionPublishes: 1,
      cleanTransitionVersioned: 1,
    });
    expect(v.behavior).toBe("publishes-versioned");
    expect(v.tier).toBe(2);
    expect(v.tierLabel).toBe("2");
  });

  it("classifies a version-less clean-transition publisher as publishes-unversioned (tier 2*)", () => {
    // opengrep-shaped: re-publishes on the clean transition but every push is
    // version-less — the wait still early-returns at runtime (the client accepts
    // a version-less publish as fresh), so this is NOT the budget-wait case.
    const v = classifyCleanBehavior({
      dirtyPublishes: 2,
      dirtyVersioned: 0,
      cleanTransitionPublishes: 1,
      cleanTransitionVersioned: 0,
    });
    expect(v.behavior).toBe("publishes-unversioned");
    expect(v.tier).toBe(2);
    expect(v.tierLabel).toBe("2*");
  });

  it("classifies dirty-publish + clean-silence as silent (tier 3 — the #458 target)", () => {
    // typescript-shaped: demonstrably alive (published on the dirty touch) but
    // demonstrably silent on clean transitions — the budget-wait case.
    const v = classifyCleanBehavior({
      dirtyPublishes: 2,
      dirtyVersioned: 0,
      cleanTransitionPublishes: 0,
      cleanTransitionVersioned: 0,
    });
    expect(v.behavior).toBe("silent");
    expect(v.tier).toBe(3);
    expect(v.tierLabel).toBe("3");
  });

  it("a versioned clean publish wins even when the dirty phase was version-less", () => {
    // The clean-transition phase is the discriminator, not the dirty phase.
    const v = classifyCleanBehavior({
      dirtyPublishes: 1,
      dirtyVersioned: 0,
      cleanTransitionPublishes: 2,
      cleanTransitionVersioned: 1,
    });
    expect(v.behavior).toBe("publishes-versioned");
    expect(v.tierLabel).toBe("2");
  });

  it("reports unknown (not tier 3) when the server never published at all", () => {
    // Conservative: a slow/absent server must not be mislabeled as measured-silent.
    const v = classifyCleanBehavior({
      dirtyPublishes: 0,
      dirtyVersioned: 0,
      cleanTransitionPublishes: 0,
      cleanTransitionVersioned: 0,
    });
    expect(v.behavior).toBe("unknown");
    expect(v.tier).toBe(0);
    expect(v.tierLabel).toBe("");
  });

  it("tolerates missing/garbage observation fields", () => {
    expect(classifyCleanBehavior({}).behavior).toBe("unknown");
    expect(
      classifyCleanBehavior(undefined as unknown as Record<string, never>)
        .behavior,
    ).toBe("unknown");
  });
});

describe("mergeSrc", () => {
  it("combines dev + ci deterministically (dev before ci)", () => {
    expect(mergeSrc("dev", "ci")).toBe("dev+ci");
    expect(mergeSrc("ci", "dev")).toBe("dev+ci");
  });
  it("is idempotent and ignores placeholder dashes", () => {
    expect(mergeSrc("dev+ci", "ci")).toBe("dev+ci");
    expect(mergeSrc("—", "dev")).toBe("dev");
    expect(mergeSrc("", "ci")).toBe("ci");
  });
});

const DOC = `# matrix

| lang | server | mode | clean-behavior | tier | src |
|---|---|---|---|---|---|
| json | vscode-json-language-server | pull | — | 1 | dev |
| typescript | typescript-language-server | push-only | TBD | 2/3? | dev |
| ast-grep | ast-grep (aux) | push-only | TBD | 2/3? | dev+ci |

tail text preserved
`;

describe("md-matrix merge guard (#390)", () => {
  it("parses the table and locates its bounds", () => {
    const tbl = parseTable(DOC, "| lang | server |");
    expect(tbl).not.toBeNull();
    expect(tbl!.header).toEqual([
      "lang",
      "server",
      "mode",
      "clean-behavior",
      "tier",
      "src",
    ]);
    expect(tbl!.rows).toHaveLength(3);
  });

  it("updates only owned columns of measured rows, preserving the rest", () => {
    const tbl = parseTable(DOC, "| lang | server |")!;
    const merged = mergeRows(
      tbl.rows,
      tbl.header,
      [
        {
          lang: "typescript",
          "clean-behavior": "silent",
          tier: "3",
          src: "dev+ci",
        },
      ],
      "lang",
      ["clean-behavior", "tier", "src"],
      { updateOnly: true },
    );
    const ts = merged.find((r) => r[0] === "typescript")!;
    expect(ts[3]).toBe("silent"); // clean-behavior updated
    expect(ts[4]).toBe("3"); // tier updated
    // `mode` (not owned) is untouched:
    expect(ts[2]).toBe("push-only");
  });

  it("preserves rows a run did NOT measure (no regression on ubuntu-poor host)", () => {
    const tbl = parseTable(DOC, "| lang | server |")!;
    // Only typescript measured this run; json + ast-grep must survive verbatim.
    const merged = mergeRows(
      tbl.rows,
      tbl.header,
      [{ lang: "typescript", "clean-behavior": "silent", tier: "3" }],
      "lang",
      ["clean-behavior", "tier"],
      { updateOnly: true },
    );
    expect(merged).toHaveLength(3); // never shrinks
    expect(merged.find((r) => r[0] === "json")).toEqual(tbl.rows[0]);
    expect(merged.find((r) => r[0] === "ast-grep")![3]).toBe("TBD"); // untouched
  });

  it("updateOnly drops a measured key with no existing row (curated table)", () => {
    const tbl = parseTable(DOC, "| lang | server |")!;
    const merged = mergeRows(
      tbl.rows,
      tbl.header,
      [{ lang: "typescript-clean", "clean-behavior": "silent", tier: "3" }],
      "lang",
      ["clean-behavior", "tier"],
      { updateOnly: true },
    );
    expect(merged).toHaveLength(3); // the unknown lang is NOT appended
    expect(merged.some((r) => r[0] === "typescript-clean")).toBe(false);
  });

  it("round-trips through replaceTable, preserving surrounding text", () => {
    const tbl = parseTable(DOC, "| lang | server |")!;
    const merged = mergeRows(
      tbl.rows,
      tbl.header,
      [{ lang: "json", mode: "pull", src: "dev+ci" }],
      "lang",
      ["src"],
      { updateOnly: true },
    );
    const out = replaceTable(DOC, "| lang | server |", tbl.header, tbl.sep, merged)!;
    expect(out).toContain("tail text preserved");
    expect(out).toContain("| json | vscode-json-language-server | pull | — | 1 | dev+ci |");
  });
});
