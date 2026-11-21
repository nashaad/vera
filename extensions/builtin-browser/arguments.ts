import { EVAL_SCRIPT_LIMIT, EVAL_TIMEOUT_DEFAULT_MS, EVAL_TIMEOUT_LIMIT_MS } from "./eval.ts";

export type BrowserAction = "open" | "read" | "click" | "type" | "scroll" | "back" | "screenshot" | "eval";

export interface BrowserRequest {
    readonly action: BrowserAction;
    readonly url?: string;
    readonly ref?: string;
    readonly text?: string;
    readonly amount?: number;
    readonly offset?: number;
    readonly script?: string;
    readonly timeout_ms?: number;
}

const ACTIONS: readonly string[] = ["open", "read", "click", "type", "scroll", "back", "screenshot", "eval"];

export function parseBrowserRequest(value: Readonly<Record<string, unknown>>): BrowserRequest | undefined {
    const action = value.action;
    if (typeof action !== "string" || !ACTIONS.includes(action)) return undefined;
    if (Object.keys(value).some((key) => !["action", "url", "ref", "text", "amount", "offset", "script", "timeout_ms"].includes(key))) return undefined;
    if (value.url !== undefined && (typeof value.url !== "string" || value.url.length > 8192)) return undefined;
    if (value.ref !== undefined && (typeof value.ref !== "string" || !/^r[0-9]{1,12}$/.test(value.ref))) return undefined;
    if (value.text !== undefined && (typeof value.text !== "string" || value.text.length > 4000)) return undefined;
    if (value.amount !== undefined && (typeof value.amount !== "number" || !Number.isFinite(value.amount) || Math.abs(value.amount) > 2000)) return undefined;
    if (value.offset !== undefined && (typeof value.offset !== "number" || !Number.isInteger(value.offset) || value.offset < 0 || value.offset > 10_000_000)) return undefined;
    if (value.script !== undefined && (typeof value.script !== "string" || value.script.length > EVAL_SCRIPT_LIMIT)) return undefined;
    if (value.timeout_ms !== undefined && (typeof value.timeout_ms !== "number" || !Number.isInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > EVAL_TIMEOUT_LIMIT_MS)) return undefined;
    if (action !== "eval" && (value.script !== undefined || value.timeout_ms !== undefined)) return undefined;
    if (action === "open") {
        try {
            if (typeof value.url !== "string" || !["http:", "https:"].includes(new URL(value.url).protocol)) return undefined;
        } catch { return undefined; }
    }
    if ((action === "click" || action === "type") && typeof value.ref !== "string") return undefined;
    if (action === "type" && typeof value.text !== "string") return undefined;
    if (action === "eval" && typeof value.script !== "string") return undefined;
    const timeout = typeof value.timeout_ms === "number" ? value.timeout_ms : action === "eval" ? EVAL_TIMEOUT_DEFAULT_MS : undefined;
    return {
        action: action as BrowserAction,
        ...(typeof value.url === "string" ? { url: value.url } : {}),
        ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
        ...(typeof value.text === "string" ? { text: value.text } : {}),
        ...(typeof value.amount === "number" ? { amount: value.amount } : {}),
        ...(typeof value.offset === "number" ? { offset: value.offset } : {}),
        ...(typeof value.script === "string" ? { script: value.script } : {}),
        ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    };
}
