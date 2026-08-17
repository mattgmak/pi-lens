/** Lazy dispatch integration seam for startup-cost control (#1394). */

type DispatchIntegration = typeof import("./integration.js");

let integrationPromise: Promise<DispatchIntegration> | undefined;

/** Start loading the runner graph once; callers may fire-and-forget this. */
export function warmDispatchIntegration(): Promise<DispatchIntegration> {
	return (integrationPromise ??= import("./integration.js"));
}

/** Await the same promise used by session-start warming and first use. */
export function loadDispatchIntegration(): Promise<DispatchIntegration> {
	return warmDispatchIntegration();
}

/** Test-only reset; production sessions intentionally retain the promise. */
export function resetDispatchIntegrationForTests(): void {
	integrationPromise = undefined;
}
