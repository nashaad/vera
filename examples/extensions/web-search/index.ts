import {
    formatSearchResults,
    searchBrave,
    searchDuckDuckGo,
} from "./search.ts";

interface ExtensionConfig {
    readonly provider?: "auto" | "duckduckgo" | "brave";
}

interface ExtensionApi {
    readonly config: unknown;
    readonly tools: {
        register(spec: {
            readonly name: string;
            readonly description: string;
            readonly inputSchema: Readonly<Record<string, unknown>>;
            readonly parallel?: boolean;
            readonly permissionOperation?: string;
            readonly run: (request: {
                readonly input: Readonly<Record<string, unknown>>;
                readonly signal: AbortSignal;
            }) => Promise<{ readonly output: string; readonly isError?: boolean }>;
        }): void;
    };
}

export function activate(vera: ExtensionApi): void {
    const config = extensionConfig(vera.config);

    vera.tools.register({
        name: "web_search",
        description: "Search the public web and return titles, URLs, and snippets.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The web search query.",
                },
                max_results: {
                    type: "integer",
                    minimum: 1,
                    maximum: 10,
                    description: "Maximum results to return. Defaults to 5.",
                },
            },
            required: ["query"],
            additionalProperties: false,
        },
        parallel: true,
        permissionOperation: "web.search",
        async run({ input, signal }) {
            const query = requiredQuery(input.query);
            const maxResults = resultLimit(input.max_results);
            const braveApiKey = process.env.BRAVE_API_KEY?.trim();
            const provider = selectedProvider(config.provider, braveApiKey);
            const results = provider === "brave"
                ? await searchBrave(query, maxResults, braveApiKey!, signal)
                : await searchDuckDuckGo(query, maxResults, signal);
            return {
                output: formatSearchResults(provider, query, results),
            };
        },
    });
}

function extensionConfig(value: unknown): ExtensionConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    const provider = (value as Record<string, unknown>).provider;
    return provider === "auto"
            || provider === "duckduckgo"
            || provider === "brave"
        ? { provider }
        : {};
}

function selectedProvider(
    configured: ExtensionConfig["provider"],
    braveApiKey: string | undefined,
): "duckduckgo" | "brave" {
    if (configured === "duckduckgo") {
        return "duckduckgo";
    }
    if (configured === "brave" && braveApiKey === undefined) {
        throw new Error(
            "Brave search requires BRAVE_API_KEY in the Vera host environment.",
        );
    }
    return configured === "brave" || braveApiKey !== undefined
        ? "brave"
        : "duckduckgo";
}

function requiredQuery(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("web_search requires a non-empty query");
    }
    return value.trim();
}

function resultLimit(value: unknown): number {
    if (value === undefined) {
        return 5;
    }
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10) {
        throw new Error("web_search max_results must be an integer from 1 to 10");
    }
    return value as number;
}
