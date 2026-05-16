import { describe, expect, it } from "vitest";
import { partitionSourceFiles } from "../../clients/source-groups.js";

describe("partitionSourceFiles", () => {
	it("keeps small groups together", () => {
		expect(partitionSourceFiles("src", ["src/a.ts", "src/b.ts"], 3)).toEqual([
			{ label: "src", files: ["src/a.ts", "src/b.ts"] },
		]);
	});

	it("splits large groups by directory segment", () => {
		const groups = partitionSourceFiles(
			"src",
			[
				"src/auth/a.ts",
				"src/auth/b.ts",
				"src/billing/a.ts",
				"src/billing/b.ts",
			],
			2,
		);

		expect(groups).toEqual([
			{ label: "src/auth", files: ["src/auth/a.ts", "src/auth/b.ts"] },
			{
				label: "src/billing",
				files: ["src/billing/a.ts", "src/billing/b.ts"],
			},
		]);
	});

	it("chunks flat directories when no deeper bucket exists", () => {
		const groups = partitionSourceFiles(
			"src",
			["src/a.ts", "src/b.ts", "src/c.ts"],
			2,
		);

		expect(groups).toEqual([
			{ label: "src#1", files: ["src/a.ts", "src/b.ts"] },
			{ label: "src#2", files: ["src/c.ts"] },
		]);
	});
});
