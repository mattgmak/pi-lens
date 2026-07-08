// Type declarations for md-matrix.mjs (untyped .mjs imported from .ts tests).

export interface ParsedTable {
  start: number;
  end: number;
  header: string[];
  sep: string;
  rows: string[][];
}

export function parseTable(text: string, headerMarker: string): ParsedTable | null;

export function mergeRows(
  existing: string[][],
  header: string[],
  measured: Record<string, string | number | undefined>[],
  keyCol: string,
  ownedCols: string[],
  opts?: { updateOnly?: boolean },
): string[][];

export function mergeSrc(existing: string, measured: string): string;

export function replaceTable(
  text: string,
  headerMarker: string,
  header: string[],
  sep: string,
  rows: string[][],
): string | null;
