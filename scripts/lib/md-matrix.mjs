// Shared merge helpers for the LSP capability docs (#390). The nightly runs on
// ubuntu-latest, which lacks many language toolchains, so a naive overwrite would
// DROP rows a richer run (e.g. the dev box) captured. These helpers MERGE: a row
// the current run measured is updated in place; a row it didn't measure (server
// unavailable/unknown here) is preserved verbatim. Server-row count never
// shrinks. Used by characterize-lsp.mjs + probe-clean-signal.mjs (which share
// docs/lsp-capability-matrix.md) and server-capabilities.mjs. #460/#390.

/**
 * Parse a GitHub-flavoured Markdown table into { header, aligns, rows } where
 * rows is an array of cell-string arrays. Only the FIRST table after `afterLine`
 * (a line whose text includes the marker) is parsed. Returns null if not found.
 *
 * @param {string} text
 * @param {string} headerMarker  a substring of the table's header row (e.g. "| lang | server |")
 * @returns {{ start: number, end: number, header: string[], sep: string, rows: string[][] } | null}
 */
export function parseTable(text, headerMarker) {
	const lines = text.split("\n");
	let headerIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(headerMarker) && lines[i].trim().startsWith("|")) {
			headerIdx = i;
			break;
		}
	}
	if (headerIdx < 0 || headerIdx + 1 >= lines.length) return null;
	const sepIdx = headerIdx + 1;
	if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[sepIdx])) return null;
	const header = splitRow(lines[headerIdx]);
	const rows = [];
	let end = sepIdx + 1;
	for (let i = sepIdx + 1; i < lines.length; i++) {
		if (!lines[i].trim().startsWith("|")) break;
		rows.push(splitRow(lines[i]));
		end = i + 1;
	}
	return { start: headerIdx, end, header, sep: lines[sepIdx], rows };
}

function splitRow(line) {
	// Strip leading/trailing pipe then split; trim each cell.
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((c) => c.trim());
}

function renderRow(cells) {
	return `| ${cells.join(" | ")} |`;
}

/**
 * Merge measured rows into an existing table's rows, keyed by a column index.
 * For each measured row, only the columns named in `ownedCols` are overwritten
 * (so two scripts sharing a table each update only their own columns); unlisted
 * columns keep the existing value. Rows present in the doc but NOT measured this
 * run are preserved. New servers are appended.
 *
 * @param {string[][]} existing   parsed existing rows
 * @param {string[]} header       column headers (for name→index)
 * @param {Object[]} measured     objects keyed by header name → cell value
 * @param {string} keyCol         header name of the unique key (e.g. "lang")
 * @param {string[]} ownedCols    header names this run is authoritative for
 * @param {{ updateOnly?: boolean }} [opts]  when updateOnly, a measured key with
 *   no existing row is DROPPED (the matrix is curated — new langs are added by
 *   hand, not appended by a probe). Default appends new keys.
 * @returns {string[][]}          merged rows
 */
export function mergeRows(existing, header, measured, keyCol, ownedCols, opts = {}) {
	const idx = (name) => header.indexOf(name);
	const keyIdx = idx(keyCol);
	const byKey = new Map();
	const order = [];
	for (const cells of existing) {
		const k = cells[keyIdx];
		byKey.set(k, [...cells]);
		order.push(k);
	}
	for (const m of measured) {
		const k = m[keyCol];
		let cells = byKey.get(k);
		if (!cells) {
			if (opts.updateOnly) continue; // don't append to a curated table
			cells = header.map((h) => (m[h] !== undefined ? String(m[h]) : ""));
			byKey.set(k, cells);
			order.push(k);
			continue;
		}
		for (const col of ownedCols) {
			const ci = idx(col);
			if (ci >= 0 && m[col] !== undefined) cells[ci] = String(m[col]);
		}
	}
	return order.map((k) => byKey.get(k));
}

/**
 * Merge a measured `src` token (e.g. "ci") into an existing one (e.g. "dev") so a
 * row measured on both surfaces reads "dev+ci". Order kept deterministic
 * (dev before ci). An empty/missing existing value just yields the new token.
 *
 * @param {string} existing
 * @param {string} measured
 * @returns {string}
 */
export function mergeSrc(existing, measured) {
	const set = new Set();
	for (const part of String(existing ?? "").split("+")) {
		const t = part.trim();
		if (t && t !== "—") set.add(t);
	}
	if (measured) set.add(measured.trim());
	const order = ["dev", "ci"];
	return [...set]
		.sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
		})
		.join("+");
}

/**
 * Replace the table located by `headerMarker` in `text` with a table built from
 * `header`/`sep`/`rows`. If no such table exists, returns null (caller decides
 * whether to append a fresh table). Preserves everything outside the table.
 *
 * @returns {string | null}
 */
export function replaceTable(text, headerMarker, header, sep, rows) {
	const tbl = parseTable(text, headerMarker);
	if (!tbl) return null;
	const lines = text.split("\n");
	const rendered = [renderRow(header), sep, ...rows.map(renderRow)];
	lines.splice(tbl.start, tbl.end - tbl.start, ...rendered);
	return lines.join("\n");
}
