import { DEFAULT_CACHE_MISS, type CacheMissSettings } from "./cache-rule.ts";

/** Axiom's ingest base for the US East 1 (AWS) edge deployment. */
export const DEFAULT_AXIOM_URL = "https://us-east-1.aws.edge.axiom.co";

export const DEFAULT_FLUSH_SECONDS = 10;

export interface AxiomSinkConfig {
    readonly type: "axiom";
    readonly dataset: string;
    readonly token: string;
    readonly url: string;
}

export interface JsonlSinkConfig {
    readonly type: "jsonl";
}

export type SinkConfig = AxiomSinkConfig | JsonlSinkConfig;

export interface TelemetryConfig {
    readonly sink: SinkConfig;
    readonly developer?: string;
    readonly flushSeconds: number;
    readonly cacheMiss: CacheMissSettings;
}

/**
 * No `sink` means the extension is off and activation does nothing. Anything
 * else malformed is an error, not a fallback to off: a typo must not look
 * like a deliberate choice not to send.
 */
export function telemetryConfig(value: unknown): TelemetryConfig | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw invalid("config", "must be an object");
    }
    const object = value as Record<string, unknown>;
    const sink = object.sink;
    if (sink === undefined || sink === null) return null;

    const developer = optionalLabel(object, "developer");
    return {
        sink: sinkConfig(sink),
        ...(developer === undefined ? {} : { developer }),
        flushSeconds: flushSeconds(object),
        cacheMiss: cacheMiss(object),
    };
}

function sinkConfig(value: unknown): SinkConfig {
    if (typeof value !== "object" || Array.isArray(value) || value === null) {
        throw invalid("sink", "must be an object");
    }
    const object = value as Record<string, unknown>;
    const type = object.type;
    if (type === "axiom") {
        const dataset = requiredString(object, "dataset", "sink");
        const token = requiredString(object, "token", "sink");
        const url = object.url === undefined ? DEFAULT_AXIOM_URL : requiredString(object, "url", "sink");
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw invalid("sink.url", "must be an http or https URL");
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            throw invalid("sink.url", "must be an http or https URL");
        }
        return { type: "axiom", dataset, token, url: url.replace(/\/+$/, "") };
    }
    if (type === "jsonl") return { type: "jsonl" };
    throw invalid("sink.type", "must be axiom or jsonl");
}

function flushSeconds(object: Record<string, unknown>): number {
    const value = object.flush_seconds;
    if (value === undefined) return DEFAULT_FLUSH_SECONDS;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw invalid("flush_seconds", "must be a number greater than 0");
    }
    return value;
}

function cacheMiss(object: Record<string, unknown>): CacheMissSettings {
    const value = object.cache_miss;
    if (value === undefined) return DEFAULT_CACHE_MISS;
    if (typeof value !== "object" || Array.isArray(value) || value === null) {
        throw invalid("cache_miss", "must be an object");
    }
    const settings = value as Record<string, unknown>;
    return {
        min_reread_tokens: wholeNumber(settings, "min_reread_tokens", DEFAULT_CACHE_MISS.min_reread_tokens),
        min_share: share(settings, "min_share", DEFAULT_CACHE_MISS.min_share),
    };
}

/** A free label, kept out of the event when blank. */
function optionalLabel(object: Record<string, unknown>, key: string): string | undefined {
    const value = object[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw invalid(key, "must be a string");
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

function requiredString(object: Record<string, unknown>, key: string, parent: string): string {
    const value = object[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw invalid(`${parent}.${key}`, "must be a non-empty string");
    }
    return value;
}

function wholeNumber(object: Record<string, unknown>, key: string, fallback: number): number {
    const value = object[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw invalid(key, "must be a whole number, 0 or more");
    }
    return value;
}

function share(object: Record<string, unknown>, key: string, fallback: number): number {
    const value = object[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || value < 0 || value > 1) {
        throw invalid(key, "must be a number from 0 to 1");
    }
    return value;
}

function invalid(path: string, problem: string): Error {
    return new Error(`telemetry: ${path} ${problem}`);
}
