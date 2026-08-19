import {
    readFreshProviderCatalogSnapshot,
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "./catalog-cache.ts";
import { mergeCatalogReleaseDates } from "./catalog-release-dates.ts";
import type {
    CatalogModel,
    ProviderCatalog,
    ReasoningLevel,
} from "./catalog-shape.ts";

const PROVIDER = "openrouter";

const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

/**
 * A cap on how long a fetch can hold up whatever asked for it, which on a
 * stale start is the host coming up. The response is around half a megabyte
 * and normally arrives in well under a second; the cap is set for the case
 * where the network is not there at all, where the cost is one wait of this
 * length before falling back to the last snapshot.
 */
const DEFAULT_TIMEOUT_MS = 2500;

export interface OpenRouterCatalogRefreshOptions {
    /** Overrides the endpoint, so tests never reach the network. */
    readonly endpoint?: string;
    /** Where the snapshot is written and read back. Defaults to Vera's cache. */
    readonly cacheDir?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    /**
     * How old the snapshot may be and still answer on its own. `0` always
     * fetches, which is what a manual refresh passes. Absent means the same,
     * so a caller that has not thought about staleness keeps the old
     * behaviour rather than silently holding a list back.
     */
    readonly maxAgeMs?: number;
}

/**
 * Fetches OpenRouter's model list and republishes it as a Vera discovery
 * snapshot. Unlike Codex, which keeps a cache on disk that Vera can simply
 * read, OpenRouter's list only exists over the network, so this is a real
 * request and can fail for reasons that have nothing to do with the user.
 *
 * A failed refresh falls back to the last snapshot rather than to nothing: the
 * model list changes slowly, and a list from yesterday is a far better answer
 * to "which models can I run" than an empty picker. `undefined` means there is
 * no answer at all, neither fresh nor remembered.
 *
 * `maxAgeMs` is what keeps this off the network on an ordinary start: a
 * snapshot younger than it is returned as-is and no request is made. Passing
 * `0` is the manual refresh, which always asks.
 */
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
    // Release dates accumulate rather than being refetched, so the snapshot
    // Vera already holds is consulted even on a successful fetch.
    const catalog = mergeCatalogReleaseDates(fetched, cachedCatalog(cacheOptions));
    if (catalog.models.length === 0) {
        // A reachable endpoint that answered with nothing usable is the same
        // situation as an unreachable one, and the remembered list is still
        // the better answer.
        return cachedCatalog(cacheOptions);
    }

    try {
        writeProviderCatalogSnapshot(catalog, cacheOptions);
    } catch {
        // A snapshot Vera cannot write is not a reason to hide models it has
        // already fetched. The next start tries again.
    }
    return catalog;
}

function cachedCatalog(
    options: { readonly cacheDir?: string },
): ProviderCatalog | undefined {
    const cached = readProviderCatalogSnapshot(PROVIDER, options);
    return cached.models.length === 0 ? undefined : cached;
}

/**
 * Only models that accept `tools` are published. Vera drives every turn through
 * tool calls, so a model without them cannot do the job at all, and offering it
 * in the picker offers a model that fails on its first turn.
 */
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
    // OpenRouter states this as seconds since the epoch. A listing without one,
    // or with one Vera cannot read, yields no date rather than a made-up one:
    // the reduction treats a missing date as "keep the model", so a guess here
    // would hide a model on invented evidence.
    const created = typeof value.created === "number"
            && Number.isSafeInteger(value.created)
            && value.created > 0
        ? value.created
        : undefined;

    return {
        id: value.id,
        label,
        ...(imageSupport === undefined ? {} : { image_support: imageSupport }),
        ...(description === undefined ? {} : { description }),
        ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
        ...(created === undefined ? {} : { created }),
        tool_support: true,
        levels: parameters.includes("reasoning")
                || parameters.includes("reasoning_effort")
            ? REASONING_LEVELS
            : [],
    };
}

/**
 * OpenRouter's `supported_parameters` names `reasoning` (the object the
 * adapter sends) on some models and `reasoning_effort` (the shorthand) on
 * others; either one means the model takes an effort. OpenRouter does not
 * publish which values each model accepts, so every reasoning-capable model
 * gets the same three levels: they are the values OpenRouter documents, and it
 * maps an effort a model does not implement onto one that model does. Levels
 * are strongest-first, as `CatalogModel.levels` requires.
 *
 * The cost of the missing per-model vocabulary is that a model with a level
 * above "high" cannot reach it from here. That is a ceiling on the level, not a
 * wrong answer, and it goes away if OpenRouter ever exposes the enum.
 */
const REASONING_LEVELS: readonly ReasoningLevel[] = [
    { id: "high", label: "High" },
    { id: "medium", label: "Medium" },
    { id: "low", label: "Low" },
];

/**
 * OpenRouter states input modalities per model under `architecture`. A listing
 * that omits the field, or states modalities Vera cannot read, yields no
 * answer rather than a false one: "text-only" and "unstated" are different
 * claims, and only the first should keep an image from being sent.
 */
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

/**
 * OpenRouter descriptions run to paragraphs of markdown; a picker row has one
 * line of plain text. The first sentence is nearly always the "what is this
 * model" sentence, which is the question the row is answering.
 *
 * The markdown is unwrapped rather than rendered: a row that reads
 * "identical to [Opus 5](/anthropic/claude-opus-5)" is showing the reader a URL
 * they cannot click in place of the words they wanted.
 */
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
        // Links keep their text and lose their target.
        .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        // Bare autolinks, which OpenRouter writes as <https://example.com>.
        .replaceAll(/<(https?:\/\/[^>]*)>/g, "$1")
        .replaceAll(/[*_`]/g, "")
        .replaceAll(/\s+/g, " ")
        .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
