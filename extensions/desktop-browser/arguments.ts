export type BrowserAction = "open" | "read" | "click" | "type" | "scroll" | "back" | "screenshot";

export interface BrowserRequest {
    readonly action: BrowserAction;
    readonly url?: string;
    readonly ref?: string;
    readonly text?: string;
    readonly amount?: number;
}

const ACTIONS: readonly string[] = ["open", "read", "click", "type", "scroll", "back", "screenshot"];

export function parseBrowserRequest(value: Readonly<Record<string, unknown>>): BrowserRequest | undefined {
    const action = value.action;
    if (typeof action !== "string" || !ACTIONS.includes(action)) return undefined;
    if (Object.keys(value).some((key) => !["action", "url", "ref", "text", "amount"].includes(key))) return undefined;
    if (value.url !== undefined && (typeof value.url !== "string" || value.url.length > 8192)) return undefined;
    if (value.ref !== undefined && (typeof value.ref !== "string" || !/^r[0-9]{1,12}$/.test(value.ref))) return undefined;
    if (value.text !== undefined && (typeof value.text !== "string" || value.text.length > 4000)) return undefined;
    if (value.amount !== undefined && (typeof value.amount !== "number" || !Number.isFinite(value.amount) || Math.abs(value.amount) > 2000)) return undefined;
    if (action === "open") {
        try {
            if (typeof value.url !== "string" || !["http:", "https:"].includes(new URL(value.url).protocol)) return undefined;
        } catch { return undefined; }
    }
    if ((action === "click" || action === "type") && typeof value.ref !== "string") return undefined;
    if (action === "type" && typeof value.text !== "string") return undefined;
    return {
        action: action as BrowserAction,
        ...(typeof value.url === "string" ? { url: value.url } : {}),
        ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
        ...(typeof value.text === "string" ? { text: value.text } : {}),
        ...(typeof value.amount === "number" ? { amount: value.amount } : {}),
    };
}
