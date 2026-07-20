import {
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { createOpenRouterAdapter } from "../src/providers/openrouter.ts";
import {
    loadSupportedModelsCatalog,
    type SuggestedModel,
    type SupportedModelsCatalog,
    type VerifiedModel,
    type VerifiedReasoningCombination,
} from "../src/model/supported-models.ts";
import type {
    AssistantMessage,
    ModelReasoningEffort,
} from "../src/model/types.ts";

interface OpenRouterModelMetadata {
    readonly id: string;
    readonly contextLength: number;
    readonly supportedParameters: readonly string[];
    readonly supportedEfforts: readonly string[];
}

const catalogPath = join(process.cwd(), "config", "supported-models.json");
const catalog = loadSupportedModelsCatalog(catalogPath);
const metadata = await discoverOpenRouterModels(catalog);

if (process.argv.includes("--discover")) {
    process.stdout.write(`${JSON.stringify(discoveryReport(catalog, metadata), null, 2)}\n`);
    process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for catalog verification");
}

const verifiedAt = new Date().toISOString();
const adapter = createOpenRouterAdapter({
    apiKey,
    reasoningMappings: candidateReasoningMappings(catalog, metadata),
});
const verifiedModels: VerifiedModel[] = [];

for (const suggested of catalog.suggested_models) {
    if (suggested.provider !== "openrouter") {
        throw new Error(
            `No catalog verifier adapter is installed for ${suggested.provider}`,
        );
    }
    const modelMetadata = requiredMetadata(metadata, suggested.model);
    const reasoning = reasoningCombinations(modelMetadata, verifiedAt);
    if (reasoning.length === 0) {
        throw new Error(
            `${suggested.provider}/${suggested.model} exposes no supported reasoning combinations`,
        );
    }
    for (const combination of reasoning) {
        await verifyTextResponse(
            adapter,
            suggested,
            combination.vera_effort,
        );
        process.stdout.write(
            `verified response ${suggested.provider}/${suggested.model} / ${combination.vera_effort}\n`,
        );
    }
    await verifyToolCall(adapter, suggested, reasoning[0]?.vera_effort ?? "max");
    process.stdout.write(`verified tool use ${suggested.provider}/${suggested.model}\n`);
    verifiedModels.push({
        ...suggested,
        context_window: modelMetadata.contextLength,
        tool_support: true,
        reasoning,
    });
}

writeCatalog(catalogPath, { ...catalog, verified_models: verifiedModels });
process.stdout.write(`updated ${catalogPath}\n`);

async function discoverOpenRouterModels(
    source: SupportedModelsCatalog,
): Promise<ReadonlyMap<string, OpenRouterModelMetadata>> {
    const endpoint = source.providers.openrouter?.models_endpoint;
    if (endpoint === undefined) {
        throw new Error("The catalog has no OpenRouter discovery endpoint");
    }
    const response = await fetch(endpoint);
    if (!response.ok) {
        throw new Error(`OpenRouter metadata request failed (${response.status})`);
    }
    const value: unknown = await response.json();
    const data = asRecord(value)?.data;
    if (!Array.isArray(data)) {
        throw new Error("OpenRouter metadata omitted its model list");
    }
    const selected = new Map<string, OpenRouterModelMetadata>();
    for (const candidate of data) {
        const model = asRecord(candidate);
        if (
            typeof model?.id !== "string"
            || !source.suggested_models.some((item) => (
                item.provider === "openrouter" && item.model === model.id
            ))
        ) {
            continue;
        }
        const reasoning = asRecord(model.reasoning);
        const supportedEfforts = reasoning?.supported_efforts;
        if (
            !Number.isSafeInteger(model.context_length)
            || !Array.isArray(model.supported_parameters)
            || !Array.isArray(supportedEfforts)
        ) {
            throw new Error(`OpenRouter metadata is incomplete for ${model.id}`);
        }
        selected.set(model.id, {
            id: model.id,
            contextLength: model.context_length as number,
            supportedParameters: strings(model.supported_parameters),
            supportedEfforts: strings(supportedEfforts),
        });
    }
    for (const suggested of source.suggested_models) {
        if (suggested.provider === "openrouter") {
            requiredMetadata(selected, suggested.model);
        }
    }
    return selected;
}

function discoveryReport(
    source: SupportedModelsCatalog,
    models: ReadonlyMap<string, OpenRouterModelMetadata>,
): unknown {
    return source.suggested_models.map((suggested) => {
        if (suggested.provider !== "openrouter") {
            return {
                ...suggested,
                error: `no discovery adapter for ${suggested.provider}`,
            };
        }
        const metadata = requiredMetadata(models, suggested.model);
        return {
            ...suggested,
            context_window: metadata.contextLength,
            tool_support: metadata.supportedParameters.includes("tools"),
            candidate_reasoning: reasoningCombinations(
                metadata,
                "unverified",
            ).map(({ vera_effort, provider_effort }) => ({
                vera_effort,
                provider_effort,
            })),
        };
    });
}

function reasoningCombinations(
    metadata: OpenRouterModelMetadata,
    verifiedAt: string,
): VerifiedReasoningCombination[] {
    const combinations = new Map<ModelReasoningEffort, string>();
    for (const providerEffort of metadata.supportedEfforts) {
        const veraEffort = veraEffortFor(providerEffort);
        if (veraEffort !== undefined && !combinations.has(veraEffort)) {
            combinations.set(veraEffort, providerEffort);
        }
    }
    return [...combinations].map(([vera_effort, provider_effort]) => ({
        vera_effort,
        provider_effort,
        verified_at: verifiedAt,
    }));
}

function candidateReasoningMappings(
    source: SupportedModelsCatalog,
    models: ReadonlyMap<string, OpenRouterModelMetadata>,
): ReadonlyMap<string, ReadonlyMap<ModelReasoningEffort, string>> {
    const mappings = new Map<
        string,
        ReadonlyMap<ModelReasoningEffort, string>
    >();
    for (const suggested of source.suggested_models) {
        if (suggested.provider !== "openrouter") {
            continue;
        }
        const combinations = reasoningCombinations(
            requiredMetadata(models, suggested.model),
            "unverified",
        );
        mappings.set(suggested.model, new Map(combinations.map((combination) => [
            combination.vera_effort,
            combination.provider_effort,
        ])));
    }
    return mappings;
}

function veraEffortFor(providerEffort: string): ModelReasoningEffort | undefined {
    if (providerEffort === "none") return "off";
    if (providerEffort === "low") return "low";
    if (providerEffort === "medium") return "medium";
    if (providerEffort === "high") return "high";
    if (providerEffort === "max" || providerEffort === "xhigh") return "max";
    return undefined;
}

async function verifyTextResponse(
    adapter: ReturnType<typeof createOpenRouterAdapter>,
    model: SuggestedModel,
    reasoningEffort: ModelReasoningEffort,
): Promise<void> {
    const result = await adapter.stream({
        model: model.model,
        reasoningEffort,
        maxTokens: 2_048,
        messages: [{
            role: "user",
            content: [{ type: "text", text: "Reply with exactly: vera-catalog-ok" }],
        }],
    }).result();
    requireSuccessful(result, `${model.provider}/${model.model}/${reasoningEffort} response`);
    const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    if (!text.toLowerCase().includes("vera-catalog-ok")) {
        throw new Error(`${model.provider}/${model.model}/${reasoningEffort} returned unexpected text: ${text}`);
    }
}

async function verifyToolCall(
    adapter: ReturnType<typeof createOpenRouterAdapter>,
    model: SuggestedModel,
    reasoningEffort: ModelReasoningEffort,
): Promise<void> {
    const result = await adapter.stream({
        model: model.model,
        reasoningEffort,
        maxTokens: 2_048,
        messages: [{
            role: "user",
            content: [{ type: "text", text: "Call catalog_probe with value ok. Do not answer in text." }],
        }],
        tools: [{
            name: "catalog_probe",
            description: "Verify that this model can call a Vera tool.",
            inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
            },
        }],
    }).result();
    requireSuccessful(result, `${model.provider}/${model.model} tool use`);
    const toolCall = result.content.find((block) => block.type === "tool_call");
    if (toolCall?.type !== "tool_call" || toolCall.name !== "catalog_probe") {
        throw new Error(`${model.provider}/${model.model} did not call catalog_probe`);
    }
}

function requireSuccessful(result: AssistantMessage, label: string): void {
    if (
        result.stopReason === "error"
        || result.stopReason === "aborted"
        || result.stopReason === "length"
    ) {
        throw new Error(`${label} failed: ${result.errorMessage ?? result.stopReason}`);
    }
}

function requiredMetadata(
    models: ReadonlyMap<string, OpenRouterModelMetadata>,
    id: string,
): OpenRouterModelMetadata {
    const metadata = models.get(id);
    if (metadata === undefined) {
        throw new Error(`OpenRouter does not list suggested model ${id}`);
    }
    if (!metadata.supportedParameters.includes("tools")) {
        throw new Error(`${id} does not advertise tool support`);
    }
    return metadata;
}

function writeCatalog(path: string, value: SupportedModelsCatalog): void {
    const temporary = join(dirname(path), `.supported-models-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}

function strings(values: readonly unknown[]): string[] {
    return values.filter((value): value is string => typeof value === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
