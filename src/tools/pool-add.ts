import type { RegisteredTool } from "./types.ts";

const MAX_MODELS = 8;

/**
 * The one agent path into the pool. The effect resolves through the same
 * admission the client's own add goes through, so both paths write the entry
 * the same way; the tool only carries the request. Add-only on purpose:
 * removal is the destructive action and stays a human action in the client.
 */
export const poolAddTool: RegisteredTool = {
    effectType: "pool_add",
    permissionOperation: "pool.add",
    definition: {
        name: "pool_add",
        description: [
            "Ask to admit models to the runtime pool by exact",
            "provider/model identifier (as returned by catalog_search).",
            "Admission is immediate and makes no provider call: the model",
            "enters with whatever the catalog knows about it and is usable",
            "straight away. The result reports a per-model verdict: added,",
            "incompatible with the reason, or unavailable with a retry hint.",
            "Only pooled models can be selected or used for subagents.",
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                models: {
                    type: "array",
                    items: { type: "string" },
                    description:
                        "Exact provider/model identifiers to verify and add.",
                },
            },
            required: ["models"],
            additionalProperties: false,
        },
    },
    async execute(input) {
        const models = input.models;
        if (
            !Array.isArray(models)
            || models.length === 0
            || !models.every((model): model is string =>
                typeof model === "string" && model.includes("/"))
        ) {
            throw new Error(
                "pool_add requires provider/model identifiers",
            );
        }
        if (models.length > MAX_MODELS) {
            throw new Error(
                `pool_add admits at most ${MAX_MODELS} models per call`,
            );
        }
        return {
            kind: "effect",
            effect: {
                type: "pool_add",
                models: models.map((model) => model.trim()),
            },
        };
    },
};
