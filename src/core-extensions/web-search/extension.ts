import type { VeraExtensionApi, VeraSearchProviderInfo } from "../../sdk/extensions.ts";
import { builtInProviders } from "./providers.ts";
import { formatSearchResults, searchWeb } from "./search.ts";
import { SearchStore } from "./store.ts";
export { activateClient } from "./client.ts";

export function activate(vera: VeraExtensionApi): void {
    for (const provider of builtInProviders()) vera.search.registerProvider(provider);
    const store = new SearchStore(vera.storage.profile, () => vera.search.providers(), undefined, undefined, vera.config);
    vera.tools.register({
        name: "web_search",
        description: "Search the public web and return titles, URLs, and snippets.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    minLength: 1,
                    maxLength: 600,
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
            const result = await searchWeb(
                input.query,
                input.max_results,
                store.providers(),
                (provider) => store.key(provider),
                signal,
            );
            return { output: formatSearchResults(result.results, result.provider.label, result.notices) };
        },
    });
    vera.requests.handle("providers", () => vera.search.providers().map((provider) => providerInfo(provider)));
    vera.requests.handle("verify", async (payload, { signal }) => {
        const id = payload !== null && typeof payload === "object" ? (payload as { id?: unknown }).id : undefined;
        const provider = vera.search.providers().find((entry) => entry.id === id);
        if (provider === undefined) throw new Error("That search provider is no longer loaded.");
        const result = await searchWeb("Vera search test", 1, [{ provider, enabled: true }],
            (entry) => store.key(entry), signal, { attemptTimeoutMs: 15_000 });
        return { count: result.results.length };
    });
}

function providerInfo(provider: VeraSearchProviderInfo): { id: string; label: string; requiresKey: boolean; keyEnv?: string } {
    return {
        id: provider.id,
        label: provider.label,
        requiresKey: provider.requiresKey,
        ...(provider.keyEnv === undefined ? {} : { keyEnv: provider.keyEnv }),
    };
}
