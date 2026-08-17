/** Shared lazy LSP service seam (#1394). */

type LspModule = typeof import("./lsp/index.js");
let lspPromise: Promise<LspModule> | undefined;

export function warmLspService(): Promise<LspModule> {
	return (lspPromise ??= import("./lsp/index.js"));
}

export function loadLspService(): Promise<LspModule> {
	return warmLspService();
}
