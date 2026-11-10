import type { JsonObject, JsonValue } from "../../src/sdk/hooks.ts";

export interface CacheWarningSettings {
    readonly windowCalls: number;
    readonly minShare: number;
    readonly minTokens: number;
}

export const DEFAULT_CACHE_WARNING: CacheWarningSettings = { windowCalls: 20, minShare: 0.25, minTokens: 250_000 };

export interface CallUsage {
    readonly provider: string;
    readonly model: string;
    /** Includes cached tokens. */
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    /** Milliseconds since the epoch. */
    readonly at: number;
}

export interface CacheMissWarning {
    readonly calls: number;
    readonly rereadTokens: number;
    readonly inputTokens: number;
    readonly provider: string;
    readonly model: string;
}

interface WindowEntry {
    readonly inputTokens: number;
    readonly reread: number;
}

/** Calls this far apart are treated as separate work, so the cache may legitimately have expired. */
const CONTINUITY_MS = 5 * 60 * 1000;
/** A bigger input drop means compaction or a new prompt, which breaks the cache legitimately. */
const MIN_INPUT_RATIO = 0.7;

export function cacheWarningSettings(config: JsonValue): CacheWarningSettings {
    if (config === null || config === undefined) return DEFAULT_CACHE_WARNING;
    if (typeof config !== "object" || Array.isArray(config)) {
        throw new Error("vera.cache config must be an object");
    }
    const object = config as JsonObject;
    return {
        windowCalls: wholeNumber(object, "window_calls", DEFAULT_CACHE_WARNING.windowCalls),
        minShare: share(object, "min_share", DEFAULT_CACHE_WARNING.minShare),
        minTokens: wholeNumber(object, "min_tokens", DEFAULT_CACHE_WARNING.minTokens),
    };
}

export function cacheWarningOn(settings: CacheWarningSettings): boolean {
    return settings.windowCalls > 0 && settings.minShare > 0 && settings.minTokens > 0;
}

function wholeNumber(object: JsonObject, key: string, fallback: number): number {
    const value = object[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(`${key} must be a whole number, 0 or more`);
    }
    return value;
}

function share(object: JsonObject, key: string, fallback: number): number {
    const value = object[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || value < 0 || value > 1) {
        throw new Error(`${key} must be a number from 0 to 1`);
    }
    return value;
}

/**
 * Watches one conversation. Warns at most once: a window of counted calls
 * re-read a large share of their input from the cache the provider already holds.
 */
export class CacheMissTracker {
    private previous: CallUsage | undefined;
    private window: WindowEntry[] = [];
    private windowProvider: string | undefined;
    private windowModel: string | undefined;
    private readonly cacheReporters = new Set<string>();
    private warned = false;

    constructor(private readonly settings: CacheWarningSettings) {}

    observe(call: CallUsage): CacheMissWarning | undefined {
        if (!cacheWarningOn(this.settings) || this.warned) {
            this.previous = call;
            return undefined;
        }
        if (call.cachedInputTokens > 0) this.cacheReporters.add(call.provider);
        const previous = this.previous;
        this.previous = call;
        if (previous === undefined || !this.counts(previous, call)) return undefined;

        const reread = Math.max(0, Math.min(previous.inputTokens, call.inputTokens) - call.cachedInputTokens);
        if (this.windowProvider !== call.provider || this.windowModel !== call.model) {
            this.window = [];
            this.windowProvider = call.provider;
            this.windowModel = call.model;
        }
        this.window.push({ inputTokens: call.inputTokens, reread });
        if (this.window.length > this.settings.windowCalls) this.window.shift();
        if (this.window.length < this.settings.windowCalls) return undefined;

        const rereadTokens = sum(this.window.map((entry) => entry.reread));
        const inputTokens = sum(this.window.map((entry) => entry.inputTokens));
        if (rereadTokens < this.settings.minTokens || rereadTokens < this.settings.minShare * inputTokens) {
            return undefined;
        }
        this.warned = true;
        return {
            calls: this.settings.windowCalls,
            rereadTokens,
            inputTokens,
            provider: call.provider,
            model: call.model,
        };
    }

    private counts(previous: CallUsage, call: CallUsage): boolean {
        return previous.provider === call.provider
            && previous.model === call.model
            && call.at - previous.at < CONTINUITY_MS
            && call.inputTokens >= MIN_INPUT_RATIO * previous.inputTokens
            && this.cacheReporters.has(call.provider);
    }
}

/** One tracker per conversation, least recently used evicted past capacity. */
export class CacheMissSessions {
    private readonly trackers = new Map<string, CacheMissTracker>();

    constructor(
        private readonly settings: CacheWarningSettings,
        private readonly capacity = 64,
    ) {}

    tracker(sessionId: string): CacheMissTracker {
        const existing = this.trackers.get(sessionId);
        const tracker = existing ?? new CacheMissTracker(this.settings);
        this.trackers.delete(sessionId);
        this.trackers.set(sessionId, tracker);
        if (this.trackers.size > this.capacity) {
            const oldest = this.trackers.keys().next().value;
            if (oldest !== undefined) this.trackers.delete(oldest);
        }
        return tracker;
    }
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}
