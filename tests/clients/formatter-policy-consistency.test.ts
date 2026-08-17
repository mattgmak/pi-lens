import { describe, expect, it } from "vitest";
import { ALL_FORMATTERS } from "../../clients/formatters.ts";
import {
	AUTO_INSTALLABLE_DEFAULT_FORMATTERS,
	FORMATTER_POLICY_BY_EXTENSION,
	FORMATTER_POLICY_BY_FILENAME,
} from "../../clients/tool-policy.ts";

// Bidirectional drift guard binding the two hand-maintained INVERSE mappings of
// the formatter↔extension relation (#1135, the #883/#209 single-source-of-truth
// class):
//   - clients/formatters.ts    : ALL_FORMATTERS[].{extensions,filenames}  (formatter → extensions)
//   - clients/tool-policy.ts   : FORMATTER_POLICY_BY_EXTENSION            (extension → formatterNames)
//
// Without this test the two lists drift silently, in either direction:
//   (1) a formatter definition gains an extension that a gating policy omits →
//       the formatter is never OFFERED for that extension (exactly #1134's
//       oxfmt/.svelte symptom, generalized to every formatter);
//   (2) a policy names a formatter for an extension the formatter's definition
//       doesn't claim → a broken option is offered.
//
// A structural derive (tool-policy.ts importing ALL_FORMATTERS to build the
// candidate lists) was rejected: formatters.ts already imports tool-policy.ts,
// so the reverse edge would create a module import cycle. This test-based guard
// keeps the dependency one-way while still binding both directions — the test is
// a leaf that may import both modules with no cycle. See #1135 for the reasoning.

const formatterByName = new Map(ALL_FORMATTERS.map((f) => [f.name, f]));
const extensionsOf = (name: string): ReadonlySet<string> =>
	new Set(formatterByName.get(name)?.extensions ?? []);

// --- Shared assertion plumbing (keep each `it` a couple of non-duplicated
// lines; #1153/#1155 duplication class). A "checker" maps one item to a
// violation message or null; `expectClean` runs it over the items and asserts
// nothing was reported, surfacing every message at once. ---
type Checker<T> = (item: T) => string | null;

function collectViolations<T>(items: Iterable<T>, check: Checker<T>): string[] {
	const violations: string[] = [];
	for (const item of items) {
		const message = check(item);
		if (message) violations.push(message);
	}
	return violations;
}

function expectClean<T>(items: Iterable<T>, check: Checker<T>): void {
	const violations = collectViolations(items, check);
	expect(violations, violations.join("\n")).toEqual([]);
}

// Flattened (item → check) inputs, built once.
const definitionExtensionPairs = ALL_FORMATTERS.flatMap((f) =>
	f.extensions.map((ext) => ({ name: f.name, ext })),
);
const extensionPolicyNamePairs = [...FORMATTER_POLICY_BY_EXTENSION].flatMap(
	([ext, policy]) => policy.formatterNames.map((name) => ({ ext, name })),
);
const filenamePolicyNamePairs = [...FORMATTER_POLICY_BY_FILENAME].flatMap(
	([filename, policy]) => policy.formatterNames.map((name) => ({ filename, name })),
);
const defaultFormatterEntries = [
	...[...FORMATTER_POLICY_BY_EXTENSION].map(([key, policy]) => ({
		kind: "extension" as const,
		key,
		defaultFormatter: policy.defaultFormatter,
	})),
	...[...FORMATTER_POLICY_BY_FILENAME].map(([key, policy]) => ({
		kind: "filename" as const,
		key,
		defaultFormatter: policy.defaultFormatter,
	})),
];

// DELIBERATE per-extension policy decisions: the formatter's definition declares
// it CAN handle the extension, but the policy intentionally routes that
// extension to a different formatter and excludes it. These must stay VISIBLE
// (an implicit silent gap is the bug this guard exists to prevent). Keyed
// "formatterName|.ext". Adding a member here is a conscious policy choice — and
// the "exclusions are real and necessary" test below rejects a decorative one.
const DELIBERATE_POLICY_EXCLUSIONS = new Set<string>([
	// HTML: prettier (+ oxfmt) own it; biome's HTML formatter is experimental and
	// intentionally not offered.
	"biome|.html",
	"biome|.htm",
	// Vue SFC: prettier (+ oxfmt) own it; biome only formats <script> blocks.
	"biome|.vue",
	// Svelte: oxfmt is the sole svelte formatter by policy (#1134); both biome and
	// prettier declare .svelte support but are deliberately excluded.
	"biome|.svelte",
	"prettier|.svelte",
]);

// Extensions a formatter definition claims that intentionally have NO
// FORMATTER_POLICY_BY_EXTENSION entry. For these, getFormattersForFile falls
// back to the no-policy detect path (all matching formatters become candidates),
// so nothing is silently dropped. Ruby (rubocop/standardrb) and SQL (sqlfluff)
// are lint-autofix formatters whose selection is driven by detect(), not a
// smart-default policy. Any NEW formatter extension that lands without a policy
// entry must be added here CONSCIOUSLY (or gain a policy) — otherwise this guard
// fails, forcing the author to decide rather than drift.
const NO_POLICY_FALLBACK_EXTS = new Set<string>([
	".sql", // sqlfluff
	".rb", // rubocop / standardrb
	".rake", // rubocop / standardrb
	".gemspec", // rubocop
	".ru", // rubocop
]);

describe("formatter ↔ policy consistency (#1135)", () => {
	it("every multi-formatter extension has one unique deterministic default (#1306)", () => {
		expectClean(FORMATTER_POLICY_BY_EXTENSION, ([ext, policy]) => {
			if (policy.formatterNames.length < 2) return null;
			const uniqueNames = new Set(policy.formatterNames);
			if (uniqueNames.size !== policy.formatterNames.length) {
				return `${ext} contains duplicate formatter claims`;
			}
			return policy.defaultFormatter && uniqueNames.has(policy.defaultFormatter)
				? null
				: `${ext} has multiple formatter candidates but no defaultFormatter among them`;
		});
	});
	it("every formatter definition extension is policy-included, a documented exclusion, or a documented no-policy fallback (direction 1: no silent drop)", () => {
		expectClean(definitionExtensionPairs, ({ name, ext }) => {
			const policy = FORMATTER_POLICY_BY_EXTENSION.get(ext);
			if (!policy) {
				// No policy entry → offered via the no-policy fallback path. Must be a
				// consciously documented fallback extension.
				return NO_POLICY_FALLBACK_EXTS.has(ext)
					? null
					: `${name} claims ${ext} but there is NO formatter policy for ${ext} and it is not in NO_POLICY_FALLBACK_EXTS (add a policy entry or document the fallback)`;
			}
			// A non-empty candidate list GATES selection to those names; if the
			// formatter isn't among them, the extension is silently dropped for it —
			// unless it's a deliberate exclusion.
			const gatedOut =
				policy.formatterNames.length > 0 &&
				!policy.formatterNames.includes(name) &&
				!DELIBERATE_POLICY_EXCLUSIONS.has(`${name}|${ext}`);
			return gatedOut
				? `${name} claims ${ext} but the ${ext} policy [${policy.formatterNames.join(", ")}] excludes it (never offered) — add it to the policy or to DELIBERATE_POLICY_EXCLUSIONS`
				: null;
		});
	});

	it("every extension-policy formatterName is a real formatter whose definition claims that extension (direction 2: no broken option)", () => {
		expectClean(extensionPolicyNamePairs, ({ ext, name }) => {
			if (!formatterByName.has(name)) {
				return `policy ${ext} names "${name}" but no formatter definition exists with that name`;
			}
			return extensionsOf(name).has(ext)
				? null
				: `policy ${ext} names "${name}" but ${name}'s definition does not claim ${ext} (broken option)`;
		});
	});

	it("every policy defaultFormatter maps to a real formatter definition (extension + filename policies; #1135 comment: terragrunt-hcl)", () => {
		expectClean(defaultFormatterEntries, ({ kind, key, defaultFormatter }) => {
			if (!defaultFormatter || formatterByName.has(defaultFormatter)) return null;
			return `${kind} policy ${key} has defaultFormatter "${defaultFormatter}" with no formatter definition`;
		});
	});

	it("every filename-policy formatterName is a real formatter whose definition claims that filename (terragrunt.hcl class)", () => {
		expectClean(filenamePolicyNamePairs, ({ filename, name }) => {
			const formatter = formatterByName.get(name);
			if (!formatter) {
				return `filename policy ${filename} names "${name}" but no formatter definition exists with that name`;
			}
			const claimed = (formatter.filenames ?? []).map((f) => f.toLowerCase());
			return claimed.includes(filename.toLowerCase())
				? null
				: `filename policy ${filename} names "${name}" but ${name}'s definition does not claim filename ${filename}`;
		});
	});

	it("every AUTO_INSTALLABLE_DEFAULT_FORMATTERS key is a real formatter definition (sibling drift, #1086)", () => {
		// Keys are formatter names consumed by getAutoInstallToolIdForFormatter (via
		// formatter.name); a rename in formatters.ts that misses this map silently
		// disables auto-install for that formatter.
		expectClean(AUTO_INSTALLABLE_DEFAULT_FORMATTERS.keys(), (name) =>
			formatterByName.has(name)
				? null
				: `AUTO_INSTALLABLE_DEFAULT_FORMATTERS names "${name}" with no formatter definition`,
		);
	});

	it("every DELIBERATE_POLICY_EXCLUSIONS pair is real AND necessary (no decorative exclusions)", () => {
		// Symmetric to NO_POLICY_FALLBACK_EXTS's minimality guard: an exclusion is
		// only legitimate if the formatter's definition DOES claim the extension AND
		// the policy DOES actually gate it out. Otherwise a future author could
		// silence a genuine "never offered" drift just by adding a decorative pair.
		expectClean(DELIBERATE_POLICY_EXCLUSIONS, (pair) => {
			const [name, ext] = pair.split("|");
			const formatter = formatterByName.get(name);
			if (!formatter) {
				return `exclusion "${pair}" names formatter "${name}" which has no definition`;
			}
			if (!formatter.extensions.includes(ext)) {
				return `exclusion "${pair}" is decorative: ${name}'s definition does not claim ${ext} (nothing to exclude)`;
			}
			const policy = FORMATTER_POLICY_BY_EXTENSION.get(ext);
			if (!policy) {
				return `exclusion "${pair}" is decorative: there is no ${ext} policy to exclude ${name} from`;
			}
			if (policy.formatterNames.length === 0 || policy.formatterNames.includes(name)) {
				return `exclusion "${pair}" is unnecessary: the ${ext} policy [${policy.formatterNames.join(", ")}] already offers ${name} — remove the exclusion`;
			}
			return null;
		});
	});

	it("NO_POLICY_FALLBACK_EXTS lists exactly the definition extensions that lack a policy (keeps the allowlist honest)", () => {
		// If a fallback extension GAINS a policy (or a listed ext no longer belongs
		// to any formatter), this fails so the allowlist can't rot into a blanket
		// escape hatch.
		const actualNoPolicy = new Set<string>();
		for (const { ext } of definitionExtensionPairs) {
			if (!FORMATTER_POLICY_BY_EXTENSION.has(ext)) actualNoPolicy.add(ext);
		}
		expect([...actualNoPolicy].sort()).toEqual([...NO_POLICY_FALLBACK_EXTS].sort());
	});
});
