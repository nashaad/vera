import type { ProviderPreferences } from "@openrouter/sdk/models";
import { ProviderPreferences$outboundSchema } from
    "@openrouter/sdk/models/providerpreferences";

import type { JsonObject, JsonValue } from "../sdk/hooks.ts";
import { providerDefinition } from "./definitions.ts";

export const MODEL_REQUEST_OPTIONS_MAX_BYTES = 64 * 1024;

export const VERA_OWNED_REQUEST_FIELDS: ReadonlySet<string> = new Set([
    "model",
    "models",
    "messages",
    "tools",
    "tool_choice",
    "stream",
    "stream_options",
    "reasoning",
    "reasoning_effort",
    "max_tokens",
    "max_completion_tokens",
]);

const REQUEST_TRANSPORT_FIELDS: ReadonlySet<string> = new Set([
    "api_key",
    "apikey",
    "authorization",
    "base_url",
    "baseurl",
    "bearer_token",
    "bearertoken",
    "credential",
    "credentials",
    "endpoint",
    "header",
    "headers",
    "password",
    "secret",
    "token",
    "url",
]);

const OPENROUTER_NESTED_FIELDS = new Map<string, ReadonlySet<string>>([
    ["max_price", new Set([
        "audio",
        "completion",
        "image",
        "prompt",
        "request",
    ])],
    ["preferred_max_latency", new Set(["p50", "p75", "p90", "p99"])],
    ["preferred_min_throughput", new Set(["p50", "p75", "p90", "p99"])],
    ["sort", new Set(["by", "partition"])],
]);

const OPENROUTER_PROVIDER_FIELDS = new Map<string, string>([
    ["allow_fallbacks", "allowFallbacks"],
    ["data_collection", "dataCollection"],
    ["enforce_distillable_text", "enforceDistillableText"],
    ["ignore", "ignore"],
    ["max_price", "maxPrice"],
    ["only", "only"],
    ["order", "order"],
    ["preferred_max_latency", "preferredMaxLatency"],
    ["preferred_min_throughput", "preferredMinThroughput"],
    ["quantizations", "quantizations"],
    ["require_parameters", "requireParameters"],
    ["sort", "sort"],
    ["zdr", "zdr"],
]);

export interface VeraModelRequestOptionsEntry {
    readonly body: JsonObject;
}

export type VeraModelRequestOptions = Readonly<
    Record<string, VeraModelRequestOptionsEntry>
>;

export interface ParsedModelReference {
    readonly provider: string;
    readonly model: string;
}

export function parseModelReference(reference: string): ParsedModelReference {
    const separator = reference.indexOf("/");
    if (
        reference.trim() !== reference
        || separator < 1
        || separator === reference.length - 1
    ) {
        throw new Error(`model reference "${reference}" must be provider/model`);
    }
    return {
        provider: reference.slice(0, separator),
        model: reference.slice(separator + 1),
    };
}

export function parseModelRequestOptions(
    value: unknown,
): VeraModelRequestOptions {
    if (!isJsonObject(value)) {
        throw new Error("model_request_options must be an object");
    }
    const result: Record<string, VeraModelRequestOptionsEntry> = {};
    for (const [reference, rawEntry] of Object.entries(value)) {
        const parsed = parseModelReference(reference);
        const definition = providerDefinition(parsed.provider);
        if (definition?.request_options === undefined) {
            throw new Error(
                `model_request_options.${reference} names provider ${parsed.provider}, which does not support request options`,
            );
        }
        if (!isJsonObject(rawEntry)) {
            throw new Error(`model_request_options.${reference} must be an object`);
        }
        const entryKeys = Object.keys(rawEntry);
        if (entryKeys.length !== 1 || entryKeys[0] !== "body") {
            throw new Error(
                `model_request_options.${reference} must contain only a body object`,
            );
        }
        if (!isJsonObject(rawEntry.body)) {
            throw new Error(`model_request_options.${reference}.body must be an object`);
        }
        validateProviderRequestBody(
            parsed.provider,
            rawEntry.body,
            `model_request_options.${reference}.body`,
        );
        result[reference] = { body: structuredClone(rawEntry.body) };
    }
    return result;
}

export function validateProviderRequestBody(
    provider: string,
    body: JsonObject,
    path = "request options",
): void {
    if (!isJsonObject(body)) {
        throw new Error(`${path} must be an object`);
    }
    assertJsonValue(body, path);
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, "utf8") > MODEL_REQUEST_OPTIONS_MAX_BYTES) {
        throw new Error(`${path} exceeds ${MODEL_REQUEST_OPTIONS_MAX_BYTES} bytes`);
    }
    for (const key of Object.keys(body)) {
        const normalized = key.toLowerCase().replaceAll("-", "_");
        if (VERA_OWNED_REQUEST_FIELDS.has(normalized)) {
            throw new Error(`${path}.${key} is owned by Vera and cannot be overridden`);
        }
    }
    visitJsonKeys(body, path, (key, keyPath) => {
        const normalized = key.toLowerCase().replaceAll("-", "_");
        if (REQUEST_TRANSPORT_FIELDS.has(normalized)) {
            throw new Error(`${keyPath} cannot contain request transport or credentials`);
        }
    });
    const definition = providerDefinition(provider);
    const behavior = definition?.request_options?.behavior;
    if (behavior === undefined) {
        throw new Error(`Provider ${provider} does not support request options`);
    }
    if (behavior === "openrouter-provider-preferences") {
        openRouterProviderPreferences(body, path);
    }
}

export function openRouterProviderPreferences(
    body: JsonObject,
    path = "OpenRouter request body",
): ProviderPreferences | undefined {
    const bodyKeys = Object.keys(body);
    const unsupportedBodyKey = bodyKeys.find((key) => key !== "provider");
    if (unsupportedBodyKey !== undefined) {
        throw new Error(`${path}.${unsupportedBodyKey} is not supported by OpenRouter request options`);
    }
    if (body.provider === undefined) return undefined;
    if (!isJsonObject(body.provider)) {
        throw new Error(`${path}.provider must be an object`);
    }
    validateOpenRouterNestedFields(body.provider, `${path}.provider`);

    const normalized: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(body.provider)) {
        const inputKey = OPENROUTER_PROVIDER_FIELDS.get(key);
        if (inputKey === undefined) {
            throw new Error(`${path}.provider.${key} is not supported`);
        }
        normalized[inputKey] = value;
    }
    for (const key of ["only", "order", "ignore"] as const) {
        const value = body.provider[key];
        if (
            value !== undefined
            && value !== null
            && (
                !Array.isArray(value)
                || value.some((entry) =>
                    typeof entry !== "string" || entry.trim().length === 0
                )
            )
        ) {
            throw new Error(`${path}.provider.${key} must contain nonempty provider names`);
        }
    }

    const parsed = ProviderPreferences$outboundSchema.safeParse(normalized);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const suffix = issue?.path.length === 0
            ? ""
            : `.${issue?.path.join(".")}`;
        throw new Error(
            `${path}.provider${suffix}: ${issue?.message ?? "invalid provider preferences"}`,
        );
    }
    if (canonicalJson(parsed.data) !== canonicalJson(body.provider)) {
        throw new Error(
            `${path}.provider contains fields or values the OpenRouter SDK would discard`,
        );
    }
    return normalized as ProviderPreferences;
}

function validateOpenRouterNestedFields(
    provider: JsonObject,
    path: string,
): void {
    for (const [key, allowed] of OPENROUTER_NESTED_FIELDS) {
        const value = provider[key];
        if (value === undefined || value === null) continue;
        if (
            key === "sort"
            && typeof value !== "string"
            && !isJsonObject(value)
        ) {
            throw new Error(`${path}.${key} must be a string or object`);
        }
        if (
            (key === "preferred_max_latency"
                || key === "preferred_min_throughput")
            && typeof value !== "number"
            && !isJsonObject(value)
        ) {
            throw new Error(`${path}.${key} must be a number or object`);
        }
        if (!isJsonObject(value)) continue;
        const unknown = Object.keys(value).find((nested) => !allowed.has(nested));
        if (unknown !== undefined) {
            throw new Error(`${path}.${key}.${unknown} is not supported`);
        }
    }
}

function visitJsonKeys(
    value: JsonValue,
    path: string,
    visit: (key: string, path: string) => void,
): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            visitJsonKeys(entry, `${path}[${index}]`, visit)
        );
        return;
    }
    if (!isJsonObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
        const keyPath = `${path}.${key}`;
        visit(key, keyPath);
        visitJsonKeys(entry, keyPath, visit);
    }
}

function canonicalJson(value: unknown): string {
    const canonical = (entry: unknown): unknown => {
        if (Array.isArray(entry)) return entry.map(canonical);
        if (!isJsonObject(entry)) return entry;
        return Object.fromEntries(
            Object.keys(entry).sort().map((key) => [key, canonical(entry[key])]),
        );
    };
    return JSON.stringify(canonical(value));
}

function assertJsonValue(
    value: unknown,
    path: string,
    ancestors: ReadonlySet<object> = new Set(),
): asserts value is JsonValue {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
    ) {
        return;
    }
    if (typeof value === "number") {
        if (Number.isFinite(value)) return;
        throw new Error(`${path} contains a non-finite number`);
    }
    if (typeof value !== "object") {
        throw new Error(`${path} contains a non-JSON value`);
    }
    if (ancestors.has(value)) {
        throw new Error(`${path} contains a cycle`);
    }
    const nested = new Set(ancestors);
    nested.add(value);
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, nested));
        return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} contains a non-JSON object`);
    }
    for (const [key, entry] of Object.entries(value)) {
        assertJsonValue(entry, `${path}.${key}`, nested);
    }
}

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
