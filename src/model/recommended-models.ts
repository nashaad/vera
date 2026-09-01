import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ModelReasoningEffort } from "./types.ts";

export interface RecommendedModel {
    readonly provider: string;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
}

export interface RecommendedModelsCatalog {
    readonly schema_version: 1;
    readonly recommended: readonly RecommendedModel[];
}

const RECOMMENDED_PATH = fileURLToPath(
    new URL("../../config/recommended-models.json", import.meta.url),
);

export function loadRecommendedModels(
    path = RECOMMENDED_PATH,
): readonly RecommendedModel[] {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecommendedModelsCatalog(value)) {
        throw new Error(`Invalid recommended-models catalog at ${path}`);
    }
    return value.recommended;
}

function isRecommendedModelsCatalog(
    value: unknown,
): value is RecommendedModelsCatalog {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const catalog = value as Record<string, unknown>;
    if (
        catalog.schema_version !== 1
        || !Array.isArray(catalog.recommended)
        || !catalog.recommended.every(isRecommendedModel)
    ) {
        return false;
    }
    const keys = catalog.recommended.map((entry) =>
        `${entry.provider}/${entry.model}`
    );
    return new Set(keys).size === keys.length;
}

function isRecommendedModel(value: unknown): value is RecommendedModel {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return typeof entry.provider === "string"
        && entry.provider.trim().length > 0
        && typeof entry.model === "string"
        && entry.model.trim().length > 0
        && (entry.reasoning_effort === undefined
            || (typeof entry.reasoning_effort === "string"
                && entry.reasoning_effort.length > 0));
}
