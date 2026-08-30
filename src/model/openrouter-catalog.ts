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

/** OpenRouter publishes decimal USD-per-token strings under prompt/completion. */
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

/**
 * The levels a model announces, and the level it picks when asked for none.
 *
 * OpenRouter states both under a per-model `reasoning` object. A model whose
 * `supported_parameters` names `reasoning` or `reasoning_effort` but carries
 * no such object accepts an effort whose vocabulary the listing does not
 * state, so it falls back to the three values OpenRouter documents; that is a
 * guess, and it is only ever made where the alternative is offering no level
 * at all. A model that announces no reasoning parameter gets no levels.
 *
 * `none` is dropped. It means "do not think", which is Vera's `off`, and a row
 * for it beside Low and Medium reads as a fourth depth rather than a switch. A
 * model whose whole vocabulary is `none` is left with no levels: it stated
 * what it takes, and the documented three are not what it said.
 */
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
        // The model stated its vocabulary and it holds nothing Vera offers as
        // a level. That is an answer, not a gap, so the documented three are
        // not put in its mouth.
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

/**
 * `CatalogModel.levels` requires strongest first. Vera's ladder decides that
 * for the levels it knows; anything else keeps the order the listing gave and
 * sorts after them, since a level Vera cannot place on the ladder is one it
 * cannot claim is stronger or weaker than another.
 */
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

/** The three values OpenRouter documents, strongest first. */
const DOCUMENTED_LEVELS: readonly ReasoningLevel[] = [
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
