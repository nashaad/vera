import { credentialFingerprint, type AuthStorage } from "./auth-storage.ts";
import {
    OPENAI_CODEX_PROVIDER_ID,
    readOpenAICodexCredentials,
} from "./openai-codex-oauth.ts";
import type {
    SubscriptionLimits,
    SubscriptionUsageWindow,
} from "./subscription-limits.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;

export interface ReadSubscriptionLimitsOptions {
    readonly authStorage: Pick<AuthStorage, "getCredential">;
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
    readonly now?: () => number;
}

interface CachedLimits {
    readonly key: string;
    readonly expiresAt: number;
    readonly value: SubscriptionLimits | null;
}

export function createOpenAICodexLimitsReader(
    options: ReadSubscriptionLimitsOptions,
): () => Promise<SubscriptionLimits | null> {
    const now = options.now ?? Date.now;
    const pending = new Map<string, Promise<SubscriptionLimits | null>>();
    let cached: CachedLimits | undefined;
    return async () => {
        const key = credentialFingerprint(options.authStorage, OPENAI_CODEX_PROVIDER_ID);
        if (key === undefined) return null;
        let credentialExpiresAt: number;
        try {
            const credentials = readOpenAICodexCredentials(options.authStorage);
            if (credentials === undefined || credentials.expires_at <= now()) return null;
            credentialExpiresAt = credentials.expires_at;
        } catch {
            return null;
        }
        if (cached?.key === key && cached.expiresAt > now()) return cached.value;
        const existing = pending.get(key);
        if (existing !== undefined) return existing;
        const request = readOpenAICodexLimits(options).then((value) => {
            const expiresAt = Math.min(
                now() + CACHE_MS,
                credentialExpiresAt,
                ...(value?.windows.map((window) => window.resetsAt) ?? []),
            );
            cached = { key, expiresAt, value };
            return value;
        }).finally(() => pending.delete(key));
        pending.set(key, request);
        return request;
    };
}

export async function readOpenAICodexLimits(
    options: ReadSubscriptionLimitsOptions,
): Promise<SubscriptionLimits | null> {
    try {
        const now = options.now ?? Date.now;
        const credentials = readOpenAICodexCredentials(options.authStorage);
        if (credentials === undefined || credentials.expires_at <= now()) {
            return null;
        }
        const headers: Record<string, string> = {
            Authorization: `Bearer ${credentials.access_token}`,
            Accept: "application/json",
        };
        if (credentials.account_id !== undefined) {
            headers["ChatGPT-Account-Id"] = credentials.account_id;
        }
        const response = await (options.fetch ?? globalThis.fetch)(USAGE_URL, {
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        return parseSubscriptionLimits(await response.json(), now());
    } catch {
        return null;
    }
}

export function parseSubscriptionLimits(
    payload: unknown,
    fetchedAt: number,
): SubscriptionLimits | null {
    if (!isRecord(payload)) return null;
    const rateLimit = payload.rate_limit;
    if (!isRecord(rateLimit)) return null;
    const windows: SubscriptionUsageWindow[] = [];
    for (const value of [rateLimit.primary_window, rateLimit.secondary_window]) {
        const window = parseWindow(value, fetchedAt);
        if (window !== null) windows.push(window);
    }
    if (windows.length === 0) return null;
    return { provider: OPENAI_CODEX_PROVIDER_ID, fetchedAt, windows };
}

function parseWindow(
    value: unknown,
    now: number,
): SubscriptionUsageWindow | null {
    if (!isRecord(value)) return null;
    const seconds = value.limit_window_seconds;
    const percent = value.used_percent;
    const reset = value.reset_at;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0
        || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100
        || typeof reset !== "number" || !Number.isFinite(reset)) {
        return null;
    }
    const resetsAt = reset * 1_000;
    if (!Number.isSafeInteger(resetsAt) || resetsAt <= now || resetsAt > 8_640_000_000_000_000) {
        return null;
    }
    return { windowMinutes: seconds / 60, usedPercent: percent, resetsAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
