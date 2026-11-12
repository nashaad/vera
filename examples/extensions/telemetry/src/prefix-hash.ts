import { createHash } from "node:crypto";

import type { PrefixPart } from "./events.ts";

/** Only this many input messages are hashed, so one hash is the same cost on every call. */
export const HASHED_MESSAGES = 4;

const MESSAGE_PARTS: readonly PrefixPart[] = ["message:0", "message:1", "message:2", "message:3"];

export interface PrefixParts {
    /** Hash of the system prompt, or of an empty prompt when there is none. */
    readonly system: string;
    /** Hash of the tool list in request order. */
    readonly tools: string;
    /** Hashes of the first four input messages, in request order. */
    readonly messages: readonly string[];
}

export interface PrefixRequest {
    readonly systemPrompt?: string;
    readonly tools?: readonly unknown[];
    readonly messages: readonly unknown[];
}

export function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * A stable string for any request value: object keys are sorted, undefined
 * object entries are skipped, and image bytes are replaced by their own hash
 * so a large attachment is never held as text.
 */
export function canonical(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (value instanceof Uint8Array) {
        return `{"$bytes":"${createHash("sha256").update(value).digest("hex")}"}`;
    }
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
        return `{${entries.join(",")}}`;
    }
    return "null";
}

export function prefixParts(request: PrefixRequest): PrefixParts {
    return {
        system: shortHash(canonical(request.systemPrompt ?? "")),
        tools: shortHash(canonical(request.tools ?? [])),
        messages: request.messages
            .slice(0, HASHED_MESSAGES)
            .map((message) => shortHash(canonical(message))),
    };
}

/**
 * Growth at the end is not a change: messages already hashed stay hashed the
 * same. The first index present in only one of the two calls is a change.
 */
export function prefixChanged(previous: PrefixParts | undefined, current: PrefixParts): PrefixPart | null {
    if (previous === undefined) return null;
    if (previous.system !== current.system) return "system";
    if (previous.tools !== current.tools) return "tools";
    const shared = Math.min(previous.messages.length, current.messages.length);
    for (let index = 0; index < shared; index += 1) {
        if (previous.messages[index] !== current.messages[index]) return MESSAGE_PARTS[index]!;
    }
    if (current.messages.length < previous.messages.length) {
        return MESSAGE_PARTS[current.messages.length]!;
    }
    return null;
}

/** The previous prefix per session, least recently used evicted past capacity. */
export class PrefixSessions {
    private readonly previous = new Map<string, PrefixParts>();

    constructor(private readonly capacity = 64) {}

    changed(sessionId: string, current: PrefixParts): PrefixPart | null {
        const seen = this.previous.get(sessionId);
        this.previous.delete(sessionId);
        this.previous.set(sessionId, current);
        if (this.previous.size > this.capacity) {
            const oldest = this.previous.keys().next().value;
            if (oldest !== undefined) this.previous.delete(oldest);
        }
        return prefixChanged(seen, current);
    }
}
