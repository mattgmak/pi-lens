/** Shared lazy formatter catalog seam (#1394). */

type FormatterModule = typeof import("./formatters.js");
let formatterPromise: Promise<FormatterModule> | undefined;

export function warmFormatters(): Promise<FormatterModule> {
	return (formatterPromise ??= import("./formatters.js"));
}

export function loadFormatters(): Promise<FormatterModule> {
	return warmFormatters();
}
