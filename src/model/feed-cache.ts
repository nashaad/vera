
import { fileURLToPath } from "node:url";

import { ladderLevelForWire } from "./admission.ts";
import {
    PROBE_LEARNED_KEY,
    TOOLS_LEARNED_KEY,
    effortLearnedKey,
    type LearnedFact,
    type LearnedFacts,
} from "./pool-file.ts";
import {
    MODEL_FEED_SCHEMA_VERSION,
    type ModelFeed,
    type ModelFeedRow,
} from "./feed-shape.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

export const FEED_FRESHNESS_MS = 4 * 24 * 60 * 60 * 1_000;

const SHIPPED_FEED_PATH = fileURLToPath(
    new URL("../../config/model-feed.json", import.meta.url),
);

export type ModelFeedSource = "fetched" | "shipped" | "none";

export interface ModelFeedResult {
    readonly feed?: ModelFeed;
    readonly source: ModelFeedSource;
    readonly refusal?: string;
}

export interface FeedFetch {
    (url: string, init?: RequestInit): Promise<Response>;
}

export interface LoadModelFeedOptions {
    readonly url?: string;
    readonly fetch?: FeedFetch;
    readonly shippedPath?: string;
    readonly signal?: AbortSignal;
}

export async function loadModelFeed(
    options: LoadModelFeedOptions = {},
): Promise<ModelFeedResult> {
    const refusal = options.url === undefined
        ? undefined
        : await fetchRefusalOrFeed(options);
    if (refusal !== undefined && typeof refusal !== "string") {
        return { feed: refusal, source: "fetched" };
    }
    const shipped = loadShippedModelFeed(
        options.shippedPath ?? SHIPPED_FEED_PATH,
    );
    return {
        ...(shipped === undefined ? {} : { feed: shipped }),
        source: shipped === undefined ? "none" : "shipped",
        ...(refusal === undefined ? {} : { refusal }),
    };
}

async function fetchRefusalOrFeed(
    options: LoadModelFeedOptions,
): Promise<ModelFeed | string> {
    const doFetch = options.fetch ?? globalThis.fetch;
    let value: unknown;
    try {
        const response = await doFetch(options.url as string, {
            ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
        });
        if (!response.ok) {
            return `feed fetch answered ${response.status}`;
        }
        value = await response.json();
    } catch (error) {
        return error instanceof Error
            ? error.message
            : "feed fetch failed";
    }
    return parseModelFeed(value)
        ?? "feed has an unknown schema version or shape";
}

export interface FeedRowReader {
    (provider: string, model: string): Promise<ModelFeedRow | undefined>;
}

export interface FeedRowReaderOptions extends LoadModelFeedOptions {
    readonly now?: () => Date;
}

export function createFeedRowReader(
    options: FeedRowReaderOptions = {},
): FeedRowReader {
    let pending: Promise<ModelFeed | undefined> | undefined;
    return async (provider, model) => {
        pending ??= loadModelFeed(options)
            .then((result) => result.feed)
            .catch(() => undefined);
        const feed = await pending;
        return feed === undefined
            ? undefined
            : freshFeedRow(feed, provider, model, options.now?.());
    };
}

export function loadShippedModelFeed(
    path = SHIPPED_FEED_PATH,
): ModelFeed | undefined {
    try {
        return parseModelFeed(JSON.parse(readRegularFileTextSync(path)));
    } catch {
        return undefined;
    }
}

/** Undefined for anything this build must not act on: a version it does not understand refuses the whole file, while a single malformed row drops that row only, so one bad entry. */
export function parseModelFeed(value: unknown): ModelFeed | undefined {
    const feed = asRecord(value);
    if (
        feed === undefined
        || feed.schema_version !== MODEL_FEED_SCHEMA_VERSION
        || typeof feed.generated_at !== "string"
        || !Array.isArray(feed.models)
    ) {
        return undefined;
    }
    return {
        schema_version: MODEL_FEED_SCHEMA_VERSION,
        generated_at: feed.generated_at,
        models: feed.models
            .map(parseRow)
            .filter((row): row is ModelFeedRow => row !== undefined),
    };
}

export function freshFeedRow(
    feed: ModelFeed,
    provider: string,
    model: string,
    now: Date = new Date(),
): ModelFeedRow | undefined {
    const row = feed.models.find((candidate) =>
        candidate.provider === provider && candidate.model === model
    );
    if (row === undefined || row.verdict !== "added") {
        return undefined;
    }
    const verifiedAt = Date.parse(row.verified_at);
    if (Number.isNaN(verifiedAt)) {
        return undefined;
    }
    const age = now.getTime() - verifiedAt;
    return age >= 0 && age <= FEED_FRESHNESS_MS ? row : undefined;
}

export function feedLearnedFacts(row: ModelFeedRow): LearnedFacts {
    const facts: Record<string, LearnedFact> = {};
    for (const wire of row.verified_levels) {
        const level = ladderLevelForWire(wire);
        if (level === undefined || level === "off") {
            continue;
        }
        facts[effortLearnedKey(level)] = {
            ok: true,
            seen: row.verified_at,
            wire,
            checked: "vera",
        };
    }
    facts[PROBE_LEARNED_KEY] = {
        ok: true,
        seen: row.verified_at,
        checked: "vera",
        ...(row.response_model === undefined
            ? {}
            : { wire: row.response_model }),
    };
    facts[TOOLS_LEARNED_KEY] = {
        ok: true,
        seen: row.verified_at,
        checked: "vera",
    };
    return facts;
}

function parseRow(value: unknown): ModelFeedRow | undefined {
    const row = asRecord(value);
    if (row === undefined) {
        return undefined;
    }
    const providerDefaultLevel = absentIfNull(row.provider_default_level);
    const responseModel = absentIfNull(row.response_model);
    const reason = absentIfNull(row.reason);
    if (
        typeof row.provider !== "string"
        || row.provider.length === 0
        || typeof row.model !== "string"
        || row.model.length === 0
        || !isVerdict(row.verdict)
        || typeof row.verified_at !== "string"
        || !Array.isArray(row.verified_levels)
        || !row.verified_levels.every(
            (level): level is string => typeof level === "string",
        )
        || !optionalString(providerDefaultLevel)
        || !optionalString(responseModel)
        || !optionalString(reason)
    ) {
        return undefined;
    }
    return {
        provider: row.provider,
        model: row.model,
        verdict: row.verdict,
        verified_levels: row.verified_levels,
        ...(providerDefaultLevel === undefined
            ? {}
            : { provider_default_level: providerDefaultLevel }),
        ...(responseModel === undefined
            ? {}
            : { response_model: responseModel }),
        ...(reason === undefined ? {} : { reason }),
        verified_at: row.verified_at,
    };
}

function isVerdict(
    value: unknown,
): value is ModelFeedRow["verdict"] {
    return value === "added"
        || value === "incompatible"
        || value === "unavailable";
}

function absentIfNull(value: unknown): unknown {
    return value === null ? undefined : value;
}

function optionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === "string";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
