import { describe, expect, it } from "vitest";
import {
	inferFeatureKind,
	inferTrustBoundaries,
} from "../../clients/feature-hints.js";

describe("feature hints", () => {
	it("infers service/database boundaries from names", () => {
		expect(inferFeatureKind("src/db/UserRepository.ts")).toBe("service");
		expect(inferTrustBoundaries("src/db/UserRepository.ts")).toEqual([
			"filesystem",
			"database",
		]);
	});

	it("infers external API boundaries from provider names", () => {
		expect(inferFeatureKind("OpenAIClient")).toBe("service");
		expect(inferTrustBoundaries("OpenAIClient")).toEqual([
			"network",
			"external-api",
			"serialization",
		]);
	});

	it("infers cli boundaries from command names", () => {
		expect(inferFeatureKind("bin/pi-lens-cli.ts")).toBe("cli-command");
		expect(inferTrustBoundaries("bin/pi-lens-cli.ts")).toEqual([
			"user-input",
			"process-exec",
		]);
	});
});
