export declare const INVALID_CLOSE_KEYWORD_MESSAGE: string;
export declare function stripNonSemanticMarkdown(body?: string): string;
export declare function parseCloseKeywords(body?: string): {
	issues: number[];
	commaLists: number[];
	offendingLines: string[];
};
export declare function lintCloseKeywords(body?: string): {
	issues: number[];
	commaLists: number[];
	offendingLines: string[];
	valid: boolean;
};
