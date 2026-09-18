import { searchDuckDuckGo, type SearchResult } from "./search.ts";

interface SearchProvider {
    readonly id: string;
    readonly label: string;
    readonly requiresKey: boolean;
    search(request: {
        readonly query: string;
        readonly count: number;
        readonly key: string | undefined;
        readonly signal: AbortSignal;
    }): Promise<readonly SearchResult[]>;
}

interface ExtensionApi {
    readonly search: {
        registerProvider(provider: SearchProvider): void;
    };
}

export const duckDuckGo: SearchProvider = {
    id: "duckduckgo",
    label: "DuckDuckGo",
    requiresKey: false,
    search: ({ query, count, signal }) => searchDuckDuckGo(query, count, signal),
};

export function activate(vera: ExtensionApi): void {
    vera.search.registerProvider(duckDuckGo);
}
