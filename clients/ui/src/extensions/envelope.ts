// The messages between the window and one extension worker. Both sides parse what they receive and refuse
// anything malformed, so a worker can never hand the window more than plain data of a known shape.

import type { ExtensionLogLevel } from "../protocol/desktop-extensions.ts";

export type ToastTone = "info" | "success" | "warning" | "danger";
export type ContextValue = string | number | boolean;
export type PlainData = null | boolean | number | string | readonly PlainData[] | { readonly [key: string]: PlainData };

export const MAX_TOAST_CHARS = 300;
export const MAX_LOG_CHARS = 8_192;
export const MAX_REASON_CHARS = 500;
export const MAX_KEY_CHARS = 100;
export const MAX_VALUE_CHARS = 200;
export const MAX_ID_CHARS = 200;
const MAX_ARGS_NODES = 1_000;
const MAX_ARGS_DEPTH = 8;
export const MAX_COMMANDS = 500;

export type ToWorker =
    | { readonly type: "load"; readonly source: string; readonly commands: readonly string[] }
    | { readonly type: "run"; readonly call: number; readonly command: string; readonly args?: PlainData }
    | { readonly type: "ping"; readonly n: number };

export type FromWorker =
    | { readonly type: "loaded" }
    | { readonly type: "load-failed"; readonly reason: string }
    | { readonly type: "done"; readonly call: number }
    | { readonly type: "failed"; readonly call: number; readonly reason: string }
    | { readonly type: "pong"; readonly n: number }
    | { readonly type: "toast"; readonly text: string; readonly tone?: ToastTone }
    | { readonly type: "log"; readonly level: ExtensionLogLevel; readonly text: string }
    | { readonly type: "context"; readonly key: string; readonly value?: ContextValue };

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length <= max;
}

function whole(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isTone(value: unknown): value is ToastTone {
    return value === "info" || value === "success" || value === "warning" || value === "danger";
}

export function isLevel(value: unknown): value is ExtensionLogLevel {
    return value === "info" || value === "warn" || value === "error";
}

// Plain data only: no functions, classes, cycles or undefined. Bounded in depth and size.
export function isPlainData(value: unknown): value is PlainData {
    let nodes = 0;
    const walk = (item: unknown, depth: number): boolean => {
        nodes += 1;
        if (nodes > MAX_ARGS_NODES || depth > MAX_ARGS_DEPTH) return false;
        if (item === null || typeof item === "boolean") return true;
        if (typeof item === "number") return Number.isFinite(item);
        if (typeof item === "string") return item.length <= MAX_LOG_CHARS;
        if (Array.isArray(item)) return item.every((entry) => walk(entry, depth + 1));
        if (!isFields(item)) return false;
        const prototype = Object.getPrototypeOf(item) as unknown;
        if (prototype !== Object.prototype && prototype !== null) return false;
        return Object.values(item).every((entry) => walk(entry, depth + 1));
    };
    return walk(value, 0);
}

export function parseToWorker(value: unknown): ToWorker | undefined {
    if (!isFields(value)) return undefined;
    if (value.type === "load") {
        const commands = value.commands;
        if (typeof value.source !== "string" || !Array.isArray(commands) || commands.length > MAX_COMMANDS) return undefined;
        if (!commands.every((id) => text(id, MAX_ID_CHARS))) return undefined;
        return { type: "load", source: value.source, commands: commands as string[] };
    }
    if (value.type === "run") {
        if (!whole(value.call) || !text(value.command, MAX_ID_CHARS)) return undefined;
        if (value.args === undefined) return { type: "run", call: value.call, command: value.command };
        return isPlainData(value.args) ? { type: "run", call: value.call, command: value.command, args: value.args } : undefined;
    }
    if (value.type === "ping") return whole(value.n) ? { type: "ping", n: value.n } : undefined;
    return undefined;
}

export function parseFromWorker(value: unknown): FromWorker | undefined {
    if (!isFields(value)) return undefined;
    switch (value.type) {
        case "loaded":
            return { type: "loaded" };
        case "load-failed":
            return text(value.reason, MAX_REASON_CHARS) ? { type: "load-failed", reason: value.reason } : undefined;
        case "done":
            return whole(value.call) ? { type: "done", call: value.call } : undefined;
        case "failed":
            return whole(value.call) && text(value.reason, MAX_REASON_CHARS)
                ? { type: "failed", call: value.call, reason: value.reason }
                : undefined;
        case "pong":
            return whole(value.n) ? { type: "pong", n: value.n } : undefined;
        case "toast":
            if (!text(value.text, MAX_TOAST_CHARS)) return undefined;
            if (value.tone === undefined) return { type: "toast", text: value.text };
            return isTone(value.tone) ? { type: "toast", text: value.text, tone: value.tone } : undefined;
        case "log":
            return isLevel(value.level) && text(value.text, MAX_LOG_CHARS)
                ? { type: "log", level: value.level, text: value.text }
                : undefined;
        case "context": {
            if (!text(value.key, MAX_KEY_CHARS) || value.key.length === 0) return undefined;
            if (value.value === undefined) return { type: "context", key: value.key };
            const item = value.value;
            const valid = typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) || text(item, MAX_VALUE_CHARS);
            return valid ? { type: "context", key: value.key, value: item as ContextValue } : undefined;
        }
        default:
            return undefined;
    }
}
