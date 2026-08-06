import type { RegisteredTool } from "./types.ts";

const MAX_MODELS = 8;

/**
 * The one agent path into the pool. The effect resolves through the same
 * engine admission service the client's checklist uses, so admission is never
 * bypassed; the tool only carries the request. Add-only on purpose: removal
 * is the destructive action and stays a human action in the client.
 */
export const poolAddTool: RegisteredTool = {
    effectType: "pool_add",
    permissionOperation: "pool.add",
    definition: {
        name: "pool_add",
        description: [
            "Ask to admit models to the runtime pool by exact",
            "provider/model identifier (as returned by catalog_search).",
            "Each model is verified with live probe calls on the user's own",
            "key before it is added; the result reports a per-model verdict:",
            "added with its verified reasoning levels, incompatible with the",
            "reason, or unavailable with a retry hint. Only pooled models",
            "can be selected or used for subagents.",
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
                `pool_add verifies at most ${MAX_MODELS} models per call`,
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
