import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.js");

const logLines = vi.hoisted(() => [] as string[]);
vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: (line: string) => {
		logLines.push(line);
	},
	SESSIONSTART_LOG_FILE: "",
	flushSessionStartLog: async () => {},
	flushSessionStartLogSync: () => {},
}));

import { ensureTool } from "../../../clients/installer/index.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";

// A tool id deliberately absent from the TOOLS registry: getToolPath() bails
// immediately on it, so this exercises the trust wrapper without touching the
// network, the package managers, or the real tools directory.
const UNKNOWN_TOOL = "pi-lens-trust-gate-fixture-tool";

let previousDisable: string | undefined;

beforeEach(() => {
	logLines.length = 0;
	previousDisable = process.env.PI_LENS_DISABLE_TOOL_INSTALL;
	// Belt-and-braces: even the "trusted" case must not be able to install.
	process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";
});

afterEach(() => {
	resetProjectTrust();
	if (previousDisable === undefined) {
		delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
	} else {
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = previousDisable;
	}
});

const gateLines = () => logLines.filter((l) => l.includes("install gated"));

describe("ensureTool project-trust gate (#1334 S5)", () => {
	it("downgrades to discovery-only when the host denied project trust", async () => {
		setProjectTrustState("untrusted");

		const resolved = await ensureTool(UNKNOWN_TOOL);

		expect(resolved).toBeUndefined();
		expect(gateLines()).toHaveLength(1);
		expect(gateLines()[0]).toContain("not trusted");
		expect(gateLines()[0]).toContain("discovery only");
	});

	it("does not gate when the host granted project trust", async () => {
		setProjectTrustState("trusted");

		await ensureTool(UNKNOWN_TOOL);

		expect(gateLines()).toHaveLength(0);
	});

	it("does not gate on a host with no trust surface at all", async () => {
		// "unknown" is the default state — older pi, MCP server, CLI, tests.
		await ensureTool(UNKNOWN_TOOL);

		expect(gateLines()).toHaveLength(0);
	});

	it("stays quiet when the caller already asked for discovery-only", async () => {
		setProjectTrustState("untrusted");

		await ensureTool(UNKNOWN_TOOL, { allowInstall: false });

		// Nothing to gate — the caller had already forbidden installs.
		expect(gateLines()).toHaveLength(0);
	});
});
