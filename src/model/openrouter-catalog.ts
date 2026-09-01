import {
    readFreshProviderCatalogSnapshot,
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "./catalog-cache.ts";
import { mergeCatalogReleaseDates } from "./catalog-release-dates.ts";
import { EFFORT_LADDER } from "./effort-ladder.ts";
import type {
    CatalogModel,
    ModelPricing,
    ProviderCatalog,
    ReasoningLevel,
} from "./catalog-shape.ts";

const PROVIDER = "openrouter";

const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

const DEFAULT_TIMEOUT_MS = 2500;

export interface OpenRouterCatalogRefreshOptions {
    readonly endpoint?: string;
    readonly cacheDir?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    readonly maxAgeMs?: number;
}

export async function refreshOpenRouterCatalog(
    options: OpenRouterCatalogRefreshOptions = {},
): Promise<ProviderCatalog | undefined> {
    const cacheOptions = options.cacheDir === undefined
        ? {}
        : { cacheDir: options.cacheDir };
    const fresh = readFreshProviderCatalogSnapshot(
        PROVIDER,
        options.maxAgeMs ?? 0,
        cacheOptions,
    );
    if (fresh !== undefined) {
        return fresh;
    }
    let raw: unknown;
    try {
        const response = await (options.fetch ?? globalThis.fetch)(
            options.endpoint ?? MODELS_ENDPOINT,
            { signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
        );
        if (!response.ok) {
            return cachedCatalog(cacheOptions);
        }
        raw = await response.json();
    } catch {
        return cachedCatalog(cacheOptions);
    }

    const fetched = normalizeOpenRouterModels(raw);
    const catalog = mergeCatalogReleaseDates(fetched, cachedCatalog(cacheOptions));
    if (catalog.models.length === 0) {
        return cachedCatalog(cacheOptions);
    }

    try {
        writeProviderCatalogSnapshot(catalog, cacheOptions);
    } catch {
    }
    return catalog;
}

function cachedCatalog(
    options: { readonly cacheDir?: string },
): ProviderCatalog | undefined {
    const cached = readProviderCatalogSnapshot(PROVIDER, options);
    return cached.models.length === 0 ? undefined : cached;
}

export function normalizeOpenRouterModels(raw: unknown): ProviderCatalog {
    const data = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
    const models: CatalogModel[] = [];
    for (const value of data) {
        const model = normalizeModel(value);
        if (model !== undefined) {
            models.push(model);
        }
    }
    return {
        schema_version: 2,
        provider: PROVIDER,
        fetched_at: new Date().toISOString(),
        models,
    };
}

function normalizeModel(value: unknown): CatalogModel | undefined {
    if (
        !isRecord(value)
        || typeof value.id !== "string"
        || value.id.length === 0
    ) {
        return undefined;
    }
    const parameters = Array.isArray(value.supported_parameters)
        ? value.supported_parameters.filter((entry): entry is string =>
            typeof entry === "string"
        )
        : [];
    if (!parameters.includes("tools")) {
        return undefined;
    }

    const imageSupport = readImageSupport(value.architecture);

    const label = typeof value.name === "string" && value.name.length > 0
        ? value.name
        : value.id;
    const description = summarize(value.description);
    const contextWindow = typeof value.context_length === "number"
        && Number.isSafeInteger(value.context_length)
        && value.context_length > 0
        ? value.context_length
        : undefined;
    const created = typeof value.created === "number"
            && Number.isSafeInteger(value.created)
            && value.created > 0
        ? value.created
        : undefined;

        const reasoning = readReasoning(
            value.reasoning,
            parameters.includes("reasoning")
                || parameters.includes("reasoning_effort"),
        );
        const pricing = readPricing(value.pricing);

        return {
            id: value.id,
            label,
            ...(imageSupport === undefined ? {} : { image_support: imageSupport }),
            ...(description === undefined ? {} : { description }),
            ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
            ...(created === undefined ? {} : { created }),
            ...(pricing === undefined ? {} : { pricing }),
            tool_support: true,
        ...(reasoning.defaultLevel === undefined
            ? {}
            : { default_level: reasoning.defaultLevel }),
        levels: reasoning.levels,
    };
}

function readPricing(
    value: unknown,
): ModelPricing | undefined {
    if (!isRecord(value)) return undefined;
    const input = perMillion(value.prompt);
    const output = perMillion(value.completion);
    if (input === undefined || output === undefined) {
        return undefined;
    }
    const cache = perMillion(value.input_cache_read);
    return {
        input,
        output,
        ...(cache === undefined ? {} : { cache }),
    };
}

function perMillion(value: unknown): number | undefined {
    if (typeof value !== "string" && typeof value !== "number") {
        return undefined;
    }
    const perToken = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(perToken) || perToken < 0) return undefined;
    const result = perToken * 1_000_000;
    return Number.isFinite(result)
        ? Math.round(result * 1_000_000_000) / 1_000_000_000
        : undefined;
}

function readReasoning(
    value: unknown,
    acceptsEffort: boolean,
): { readonly levels: readonly ReasoningLevel[]; readonly defaultLevel?: string } {
    if (!acceptsEffort) {
        return { levels: [] };
    }
    const announced = isRecord(value) && Array.isArray(value.supported_efforts)
        ? value.supported_efforts.filter((entry): entry is string =>
            typeof entry === "string" && entry.length > 0
        )
        : undefined;
    if (announced === undefined || announced.length === 0) {
        return { levels: DOCUMENTED_LEVELS };
    }
    const efforts = announced.filter((entry) => entry !== "none");
    if (efforts.length === 0) {
        return { levels: [] };
    }
    const levels = strongestFirst(dedupe(efforts)).map((id) => ({
        id,
        label: LEVEL_LABELS[id] ?? titleCase(id),
    }));
    const declaredDefault = isRecord(value)
            && typeof value.default_effort === "string"
        ? value.default_effort
        : undefined;
    const defaultLevel =
        declaredDefault !== undefined
            && levels.some((level) => level.id === declaredDefault)
            ? declaredDefault
            : undefined;
    return {
        levels,
        ...(defaultLevel === undefined ? {} : { defaultLevel }),
    };
}

function dedupe(ids: readonly string[]): readonly string[] {
    return [...new Set(ids)];
}

function strongestFirst(ids: readonly string[]): readonly string[] {
    const ladder: readonly string[] = EFFORT_LADDER;
    const known = ladder.filter((level) => ids.includes(level)).reverse();
    const unknown = ids.filter((id) => !ladder.includes(id));
    return [...known, ...unknown];
}

function titleCase(id: string): string {
    return id
        .split(/[_-]+/)
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

const LEVEL_LABELS: Readonly<Record<string, string>> = {
    max: "Max",
    xhigh: "Extra High",
    high: "High",
    medium: "Medium",
    low: "Low",
    minimal: "Minimal",
    off: "Off",
};

const DOCUMENTED_LEVELS: readonly ReasoningLevel[] = [
    { id: "high", label: "High" },
    { id: "medium", label: "Medium" },
    { id: "low", label: "Low" },
];

function readImageSupport(architecture: unknown): boolean | undefined {
    if (!isRecord(architecture)) {
        return undefined;
    }
    const modalities = architecture.input_modalities;
    if (!Array.isArray(modalities) || modalities.length === 0) {
        return undefined;
    }
    const named = modalities.filter((entry): entry is string =>
        typeof entry === "string"
    );
    return named.length === 0 ? undefined : named.includes("image");
}

const DESCRIPTION_MAX_LENGTH = 96;

function summarize(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const text = plainText(value);
    if (text.length === 0) {
        return undefined;
    }
    const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
    return sentence.length > DESCRIPTION_MAX_LENGTH
        ? `${sentence.slice(0, DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`
        : sentence;
}

function plainText(markdown: string): string {
    return markdown
        .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replaceAll(/<(https?:\/\/[^>]*)>/g, "$1")
        .replaceAll(/[*_`]/g, "")
        .replaceAll(/\s+/g, " ")
        .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
