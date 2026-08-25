import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ReasoningLevelId } from "./catalog-shape.ts";
import type { ModelReasoningEffort } from "./types.ts";
import type { ReductionReason } from "./catalog-reduction.ts";

export interface SuggestedModel {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly description: string;
    readonly contextWindow?: number;
    /** Host-resolved fact: this provider can be asked for its list again. */
    readonly refreshable?: boolean;
    /**
     * When the provider first listed the model, in seconds since the epoch.
     * Absent on a model nothing has dated, which the picker reads as a reason
     * to show it rather than a reason to hide it.
     */
    readonly created?: number;
    /**
     * Why the picker folds this row away until the user asks for everything.
     * Absent means the row is shown. The row travels either way: hiding is the
     * client's default, not the host withholding a model.
     */
    readonly hiddenByDefault?: ReductionReason;
    /** True on a model Vera's shipped curation recommends. */
    readonly recommended?: boolean;
    /** The level the curation recommends it at. A note, not a gate. */
    readonly recommendedLevel?: ReasoningLevelId;
}

export interface VerifiedReasoningCombination {
    readonly vera_effort: ModelReasoningEffort;
    readonly provider_effort: string;
    readonly verified_at: string;
}

export interface VerifiedModel extends SuggestedModel {
    readonly context_window: number;
    readonly tool_support: boolean;
    readonly image_support?: boolean;
    readonly reasoning: readonly VerifiedReasoningCombination[];
}

export interface SupportedModelsCatalog {
    readonly schema_version: 1;
    readonly providers: {
        readonly openrouter?: {
            readonly models_endpoint: string;
        };
    };
    readonly suggested_models: readonly SuggestedModel[];
    readonly verified_models: readonly VerifiedModel[];
}

const CATALOG_PATH = fileURLToPath(
    new URL("../../config/supported-models.json", import.meta.url),
);

export function loadSupportedModelsCatalog(
    path = CATALOG_PATH,
): SupportedModelsCatalog {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isSupportedModelsCatalog(value)) {
        throw new Error(`Invalid supported-model catalog at ${path}`);
    }
    return value;
}

export function verifiedModel(
    provider: string,
    model: string,
    catalog = loadSupportedModelsCatalog(),
): VerifiedModel | undefined {
    return catalog.verified_models.find((candidate) => (
        candidate.provider === provider && candidate.model === model
    ));
}

export function verifiedReasoningEfforts(
    provider: string,
    model: string,
    catalog = loadSupportedModelsCatalog(),
): readonly ModelReasoningEffort[] {
    return verifiedModel(provider, model, catalog)?.reasoning.map(
        (combination) => combination.vera_effort,
    ) ?? [];
}

function isSupportedModelsCatalog(value: unknown): value is SupportedModelsCatalog {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const catalog = value as Record<string, unknown>;
    return catalog.schema_version === 1
        && isProviders(catalog.providers)
        && Array.isArray(catalog.suggested_models)
        && catalog.suggested_models.every(isSuggestedModel)
        && Array.isArray(catalog.verified_models)
        && catalog.verified_models.every(isVerifiedModel);
}

function isSuggestedModel(value: unknown): value is SuggestedModel {
    const model = asRecord(value);
    return typeof model?.provider === "string"
        && typeof model.model === "string"
        && typeof model.label === "string"
        && typeof model.description === "string"
        && (model.contextWindow === undefined
            || (Number.isSafeInteger(model.contextWindow)
                && (model.contextWindow as number) > 0));
}

function isProviders(value: unknown): boolean {
    const providers = asRecord(value);
    const openrouter = asRecord(providers?.openrouter);
    return providers !== undefined
        && (openrouter === undefined
            || typeof openrouter.models_endpoint === "string");
}

function isVerifiedModel(value: unknown): value is VerifiedModel {
    const model = asRecord(value);
    if (model === undefined || !isSuggestedModel(value)) {
        return false;
    }
    return Number.isSafeInteger(model.context_window)
        && (model.context_window as number) > 0
        && typeof model.tool_support === "boolean"
        && Array.isArray(model.reasoning)
        && model.reasoning.every(isVerifiedReasoning);
}

function isVerifiedReasoning(value: unknown): boolean {
    const reasoning = asRecord(value);
    return isModelReasoningEffort(reasoning?.vera_effort)
        && typeof reasoning?.provider_effort === "string"
        && typeof reasoning.verified_at === "string"
        && !Number.isNaN(Date.parse(reasoning.verified_at));
}

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
    return typeof value === "string" && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
