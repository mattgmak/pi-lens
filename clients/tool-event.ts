/**
 * Local re-implementation of the host SDK's `isToolCallEventType`.
 *
 * Why this exists instead of importing from `@earendil-works/pi-coding-agent`:
 * pi installs extension dependencies with `npm install --omit=dev`, so the host
 * coding-agent package is NOT present in the extension's `node_modules` at
 * runtime. Importing a *runtime value* from it therefore fails to resolve on a
 * clean install. Pulling it in as a real dependency is worse — it drags a huge
 * transitive tree (LLM provider SDKs) whose deeply nested paths exceed Windows'
 * MAX_PATH, which breaks `git clean -fdx` during `pi update`.
 *
 * The SDK function is a one-line discriminant check, so we inline it and keep
 * every `@earendil-works/pi-coding-agent` import type-only (types compile away).
 * `tests/host-sdk-type-only.test.ts` pins that invariant.
 *
 * ## S6 audit: the per-tool `is*ToolResult` discriminators (#1334)
 *
 * The SDK also exports seven `tool_result` discriminators — `isBashToolResult`,
 * `isReadToolResult`, `isEditToolResult`, `isWriteToolResult`,
 * `isGrepToolResult`, `isFindToolResult`, `isLsToolResult`. pi-lens does NOT
 * consolidate onto them, and the reasons are worth recording so the question
 * isn't relitigated:
 *
 * 1. **They are runtime values, not types.** Same `--omit=dev` constraint as
 *    above — importing them would break on a clean user install. Inlining them
 *    is the only option, and each one's entire body is verbatim
 *    `e.toolName === "<name>"` (checked against the pinned SDK's `types.js`).
 * 2. **`isToolCallEventType` already subsumes all seven.** It is the SDK's own
 *    generic form of the same check, and it is already inlined below and used
 *    at pi-lens's `tool_call` sites. Adding seven fixed-name aliases of a
 *    generic we already have would be indirection, not consolidation.
 * 3. **The seven cover strictly fewer tools than pi-lens intercepts.** They
 *    enumerate the built-ins only; pi-lens's `tool_call`/`tool_result` paths
 *    also key off `lsp_navigation` and pi-lens's own registered tools, which no
 *    host discriminator names.
 * 4. **Narrowing to the host union would LOSE fields pi-lens reads.** The host
 *    `ToolResultEvent` declares `toolCallId`/`input`/`content`/`isError`/
 *    `details`/`usage`; pi-lens's local `ToolResultEvent`
 *    (`clients/runtime-tool-result.ts`) additionally carries
 *    `id`/`callId`/`requestId`/`provider`/`model`/`sessionId`/`session`, which
 *    the telemetry-identity path reads. A guard that narrowed to
 *    `EditToolResultEvent` would drop them.
 *
 * What IS consolidated is the part that costs nothing: the host's `details`
 * SHAPES are type-only exports, so `EditToolDetails` & co. are imported as
 * types rather than re-declared ad hoc. Genuinely pi-lens-specific `details`
 * payloads (`searchReads`, `piLensPartialApply`) stay hand-declared — no host
 * type describes them.
 */
export function isToolCallEventType<T extends string>(
	toolName: T,
	event: unknown,
): boolean {
	return (
		!!event &&
		typeof event === "object" &&
		(event as { toolName?: unknown }).toolName === toolName
	);
}
