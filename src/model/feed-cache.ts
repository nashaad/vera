/**
 * The consumer half of the custodian feed: fetch, validate, and read rows.
 *
 * The shipped copy is the floor: a fetch that fails, returns malformed JSON,
 * or carries a schema version this build does not understand falls back to the
 * copy in the repo rather than surfacing an error, because the feed is only a
 * fast path and the local probe remains the guarantee.
 *
 * Freshness is bound to the feed run's cadence: a row older than one missed
 * run (four days) stops counting, so a stalled central run degrades to local
 * probing instead of vouching forever.
 */

import { readFileSync } from "node:fs";
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

/** One missed two-day cadence: the point a hit stops counting as fresh. */
export const FEED_FRESHNESS_MS = 4 * 24 * 60 * 60 * 1_000;

const SHIPPED_FEED_PATH = fileURLToPath(
    new URL("../../config/model-feed.json", import.meta.url),
);

export type ModelFeedSource = "fetched" | "shipped" | "none";

export interface ModelFeedResult {
    readonly feed?: ModelFeed;
    readonly source: ModelFeedSource;
    /** Why the fetched copy was not used, when it was not. */
    readonly refusal?: string;
}

export interface FeedFetch {
    (url: string, init?: RequestInit): Promise<Response>;
}

export interface LoadModelFeedOptions {
    /** Absent means no fetch is attempted and the shipped copy answers. */
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

/**
 * One feed load per process, shared by every admission that follows.
 *
 * Every failure answers `undefined`, which is the same answer as a model the
 * feed has never heard of, so an unreachable or malformed feed costs a local
 * probe rather than a session.
 */
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
        return parseModelFeed(JSON.parse(readFileSync(path, "utf8")));
    } catch {
        return undefined;
    }
}

/**
 * Undefined for anything this build must not act on: a version it does not
 * understand refuses the whole file, while a single malformed row drops that
 * row only, so one bad entry cannot cost every model the fast path.
 */
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

/**
 * The row that lets admission skip the local probe, or undefined. Only an
 * `added` row within the freshness window answers: a published failure is a
 * fact worth reading elsewhere, but it never vouches for a skip.
 */
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

/**
 * A fresh feed row as the learned facts a local probe would have recorded,
 * with `checked: "vera"` naming who vouches. The level mapping is the same
 * one admission uses, so a feed-admitted model and a locally probed one
 * normalize identically; a wire string that maps to no ladder rung is dropped
 * rather than recorded against a rung it does not name.
 */
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
    // The published feed writes JSON null for an optional field it has no
    // value for. Dropping the row over it would cost every model the fast
    // path, so null and absent are read the same way.
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
