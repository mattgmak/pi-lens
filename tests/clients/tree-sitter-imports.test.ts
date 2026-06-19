/**
 * Import-extraction smoke test (#249) — one case per supported grammar.
 *
 * For every language with an IMPORT_QUERIES entry, parse a fixture with the
 * SHIPPED tree-sitter WASM and assert the import sources extract. This is a
 * regression guard against grammar drift (a grammar update that breaks a query
 * shows up here, not as silently-missing import edges in the review graph).
 *
 * NOTE: this exercises import extraction specifically. Several languages'
 * *symbol* (defs/refs) queries are currently broken against their shipped
 * grammars (kotlin/php/ocaml/dart) — tracked separately; the extractor's
 * per-query-independent init means a broken symbol query no longer disables
 * imports, which is exactly what this test locks in.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

interface ImportCase {
	file: string;
	src: string;
	expect: string[];
}

const CASES: Record<string, ImportCase> = {
	python: {
		file: "a.py",
		src: "import os\nfrom os.path import join\n",
		expect: ["os", "os.path"],
	},
	go: {
		file: "a.go",
		src: 'package m\nimport (\n\t"fmt"\n\t"strings"\n)\n',
		expect: ["fmt", "strings"],
	},
	rust: { file: "a.rs", src: "use std::io;\n", expect: ["std::io"] },
	java: {
		file: "A.java",
		src: "import java.util.List;\n",
		expect: ["java.util.List"],
	},
	kotlin: {
		file: "A.kt",
		src: "import kotlin.collections.List\n",
		expect: ["kotlin.collections.List"],
	},
	csharp: {
		file: "A.cs",
		src: "using System;\nusing System.Collections.Generic;\n",
		expect: ["System", "System.Collections.Generic"],
	},
	swift: { file: "A.swift", src: "import Foundation\n", expect: ["Foundation"] },
	php: { file: "a.php", src: "<?php\nuse App;\n", expect: ["App"] },
	ocaml: { file: "a.ml", src: "open Core\n", expect: ["Core"] },
	dart: { file: "a.dart", src: 'import "dart:io";\n', expect: ["dart:io"] },
};

let client: TreeSitterClient;
beforeAll(async () => {
	client = new TreeSitterClient();
	await client.init();
});

describe("tree-sitter import extraction (#249) — per supported grammar", () => {
	for (const [lang, c] of Object.entries(CASES)) {
		it(`extracts imports for ${lang}`, async () => {
			const env = setupTestEnvironment(`pi-lens-imp-${lang}-`);
			try {
				const fp = createTempFile(env.tmpDir, c.file, c.src);
				const tree = await client.parseFile(fp, lang);
				expect(tree).toBeTruthy();
				const extractor = new TreeSitterSymbolExtractor(lang, client);
				expect(await extractor.init()).toBe(true);
				const sources = extractor
					.extract(tree, fp, c.src)
					.imports.map((i) => i.source);
				for (const expected of c.expect) {
					expect(sources).toContain(expected);
				}
			} finally {
				env.cleanup();
			}
		});
	}
});
