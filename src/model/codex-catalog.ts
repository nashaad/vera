import type {
    CatalogModel,
    ProviderCatalog,
    ReasoningLevel,
} from "./catalog-shape.ts";

const PROVIDER = "openai-codex";

export function normalizeCodexModelCache(raw: unknown): ProviderCatalog {
    try {
        if (!isRecord(raw) || !Array.isArray(raw.models)) {
            return emptyCatalog();
        }

        const models: CatalogModel[] = [];
        for (const value of raw.models) {
            const model = normalizeModel(value);
            if (model !== undefined) {
                models.push(model);
            }
        }

        return {
            schema_version: 2,
            provider: PROVIDER,
            ...(typeof raw.fetched_at === "string"
                ? { fetched_at: raw.fetched_at }
                : {}),
            models,
        };
    } catch {
        return emptyCatalog();
    }
}

function normalizeModel(value: unknown): CatalogModel | undefined {
    if (
        !isRecord(value)
        || typeof value.slug !== "string"
        || typeof value.display_name !== "string"
        || value.visibility === "hide"
    ) {
        return undefined;
    }

    return {
        id: value.slug,
        label: value.display_name,
        ...(typeof value.description === "string"
            ? { description: value.description }
            : {}),
        ...(typeof value.priority === "number"
            ? { order: value.priority }
            : {}),
        ...(typeof value.context_window === "number"
            ? { context_window: value.context_window }
            : {}),
        ...(typeof value.default_reasoning_level === "string"
            ? { default_level: value.default_reasoning_level }
            : {}),
        levels: normalizeLevels(value.supported_reasoning_levels),
    };
}

function normalizeLevels(value: unknown): ReasoningLevel[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const levels: ReasoningLevel[] = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.effort !== "string") {
            continue;
        }
        levels.push({
            id: entry.effort,
            label: reasoningLevelLabel(entry.effort),
            ...(typeof entry.description === "string"
                ? { description: entry.description }
                : {}),
        });
    }
    return levels;
}

function reasoningLevelLabel(id: string): string {
    if (id === "xhigh") {
        return "Extra High";
    }
    return id
        .split(/[-_]/)
        .filter((part) => part.length > 0)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(" ");
}

function emptyCatalog(): ProviderCatalog {
    return {
        schema_version: 2,
        provider: PROVIDER,
        models: [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
