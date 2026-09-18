import type { VeraExtensionApi } from "../../sdk/extensions.ts";
import { formatSearchResults, searchWeb } from "./search.ts";

import { SearchStore } from "./store.ts";
export { activateClient } from "./client.ts";

export function activate(vera: VeraExtensionApi): void {
    const store = new SearchStore(vera.storage.profile, undefined, undefined, vera.config);
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
            return { output: formatSearchResults(result.results, result.provider, result.notices) };
        },
    });
}
