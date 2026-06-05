/**
 * Shared mock for the pi ExtensionAPI used across integration tests.
 *
 * Pattern adapted from pi-subagents: centralise the mock so every test file
 * gets the same shape without duplicating the inline factory.
 */

import { vi } from "vitest";

export type Handler = (event: unknown, ctx: unknown) => unknown;

export interface MockPi {
	registerTool: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	getAllTools: ReturnType<typeof vi.fn>;
	getActiveTools: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
}

export interface MockPiResult {
	pi: MockPi;
	/** Event handlers registered via `pi.on(event, handler)`. */
	handlers: Record<string, Handler[]>;
	/** Commands registered via `pi.registerCommand(name, config)`. */
	commands: Map<string, { handler?: Handler; description?: string }>;
	/** Registered tools (name → tool definition). */
	tools: Map<string, unknown>;
	/** Trigger a registered event by name. */
	trigger(event: string, eventObj: unknown, ctx?: unknown): Promise<unknown[]>;
}

/**
 * Create a minimal pi ExtensionAPI mock.
 *
 * @param flagOverrides  Override default flag values for this test.
 *
 * Default flags:
 *   - lens-lsp: true
 *   - no-lsp: false
 *   - lens-guard: false
 */
export function createMockPi(
	flagOverrides: Record<string, boolean> = {},
): MockPiResult {
	const handlers: Record<string, Handler[]> = {};
	const commands = new Map<
		string,
		{ handler?: Handler; description?: string }
	>();
	const tools = new Map<string, unknown>();
	const flags = new Map<string, boolean>([
		["lens-lsp", true],
		["no-lsp", false],
		["lens-guard", false],
		...Object.entries(flagOverrides),
	]);

	const pi: MockPi = {
		registerTool: vi.fn((tool: { name?: string }) => {
			if (tool?.name) tools.set(tool.name, tool);
		}),
		registerCommand: vi.fn(
			(name: string, config: { handler?: Handler; description?: string }) => {
				commands.set(name, config);
			},
		),
		registerFlag: vi.fn((name: string, config: { default?: boolean }) => {
			if (!flags.has(name) && typeof config?.default === "boolean") {
				flags.set(name, config.default);
			}
		}),
		on: vi.fn((event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
		}),
		getFlag: vi.fn((name: string) => flags.get(name) ?? false),
		getAllTools: vi.fn(() => [...tools.values()]),
		getActiveTools: vi.fn(() => [...tools.keys()]),
		setActiveTools: vi.fn(),
	};

	async function trigger(
		event: string,
		eventObj: unknown,
		ctx: unknown = {},
	): Promise<unknown[]> {
		const list = handlers[event] ?? [];
		const results: unknown[] = [];
		for (const h of list) {
			results.push(await h(eventObj, ctx));
		}
		return results;
	}

	return { pi, handlers, commands, tools, trigger };
}
