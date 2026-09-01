import { listDiscoveredProviders } from "../model/catalog-cache.ts";
import { effectiveCatalog } from "../model/catalog.ts";
import type { RegisteredTool, ToolOutput } from "./types.ts";

const MAX_RESULTS = 20;

export const catalogSearchTool: RegisteredTool = {
    parallel: true,
    definition: {
        name: "catalog_search",
        description: [
            "Search the model catalog for exact provider/model identifiers",
            "and their known capability facts (reasoning levels, context",
            "window, tool support). The catalog is discovery only: a model",
            "found here cannot be selected until the user, or pool_add with",
            "the user's approval, admits it to the pool.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description:
                        "Substring matched against model ids and labels.",
                },
                provider: {
                    type: "string",
                    description: "Limit the search to one provider.",
                },
            },
            required: ["query"],
            additionalProperties: false,
        },
    },
    async execute(input): Promise<ToolOutput> {
        if (typeof input.query !== "string" || input.query.trim().length === 0) {
            throw new Error("catalog_search requires a non-empty query");
        }
        const query = input.query.trim().toLowerCase();
        const providers = typeof input.provider === "string"
                && input.provider.trim().length > 0
            ? [input.provider.trim()]
            : listDiscoveredProviders();
        const matches: string[] = [];
        let matched = 0;
        for (const provider of providers) {
            for (const model of effectiveCatalog(provider).models) {
                if (
                    !model.id.toLowerCase().includes(query)
                    && !model.label.toLowerCase().includes(query)
                ) {
                    continue;
                }
                matched += 1;
                if (matches.length >= MAX_RESULTS) {
                    continue;
                }
                const facts = [
                    model.context_window === undefined
                        ? undefined
                        : `context ${model.context_window}`,
                    model.tool_support === undefined
                        ? undefined
                        : `tools ${model.tool_support ? "yes" : "no"}`,
                    model.levels.length === 0
                        ? "no reasoning control"
                        : `levels ${
                            model.levels.map((level) => level.id).join("/")
                        }`,
                ].filter((fact) => fact !== undefined);
                matches.push(
                    `${provider}/${model.id} (${model.label}): ${
                        facts.join(", ")
                    }`,
                );
            }
        }
        if (matched === 0) {
            return {
                kind: "output",
                output: `No catalog models match "${input.query.trim()}".`,
                isError: false,
            };
        }
        const overflow = matched > matches.length
            ? `\n(${matched - matches.length} more matches not shown; narrow the query.)`
            : "";
        return {
            kind: "output",
            output: matches.join("\n") + overflow,
            isError: false,
        };
    },
};
