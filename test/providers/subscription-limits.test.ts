import { expect, test } from "bun:test";

import type { AuthStorage } from "../../src/providers/auth-storage.ts";
import {
    createOpenAICodexLimitsReader,
    parseSubscriptionLimits,
    readOpenAICodexLimits,
} from "../../src/providers/openai-codex-limits.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "../../src/providers/openai-codex-oauth.ts";

const NOW = 1_800_000_000_000;
const RESET = NOW / 1_000 + 3_600;
const PAYLOAD = {
    rate_limit: {
        primary_window: { used_percent: 23, limit_window_seconds: 18_000, reset_at: RESET },
        secondary_window: { used_percent: 81, limit_window_seconds: 604_800, reset_at: RESET + 86_400 },
    },
    credits: { balance: "99" },
    additional_rate_limits: [{ metered_feature: "other" }],
};

function storage(expiresAt = NOW + 60_000, accountId?: string): Pick<AuthStorage, "getCredential"> {
    return {
        getCredential: () => ({
            type: "oauth",
            token: JSON.stringify({
                schema_version: 1,
                access_token: "test-access",
                refresh_token: "test-refresh",
                expires_at: expiresAt,
                ...(accountId === undefined ? {} : { account_id: accountId }),
            }),
        }),
    };
}

test("subscription windows preserve percentages and convert seconds to minutes and milliseconds", () => {
    expect(parseSubscriptionLimits(PAYLOAD, NOW)).toEqual({
        provider: OPENAI_CODEX_PROVIDER_ID,
        fetchedAt: NOW,
        windows: [
            { windowMinutes: 300, usedPercent: 23, resetsAt: RESET * 1_000 },
            { windowMinutes: 10_080, usedPercent: 81, resetsAt: (RESET + 86_400) * 1_000 },
        ],
    });
});

test("absent and changed subscription payloads hide instead of inventing a limit", () => {
    for (const payload of [null, [], {}, { rate_limit: null }, { rate_limit: {} }]) {
        expect(parseSubscriptionLimits(payload, NOW)).toBeNull();
    }
    for (const value of [-1, 101, Number.NaN, Infinity, "25", null]) {
        expect(parseSubscriptionLimits({ rate_limit: {
            primary_window: { ...PAYLOAD.rate_limit.primary_window, used_percent: value },
        } }, NOW)).toBeNull();
    }
    for (const seconds of [0, -1, Number.NaN, Infinity, "18000"]) {
        expect(parseSubscriptionLimits({ rate_limit: {
            primary_window: { ...PAYLOAD.rate_limit.primary_window, limit_window_seconds: seconds },
        } }, NOW)).toBeNull();
    }
    for (const reset of [0, NOW / 1_000, Infinity, "1800000000", 1e20]) {
        expect(parseSubscriptionLimits({ rate_limit: {
            primary_window: { ...PAYLOAD.rate_limit.primary_window, reset_at: reset },
        } }, NOW)).toBeNull();
    }
});

test("a missing window leaves the valid window and zero use remains known", () => {
    const result = parseSubscriptionLimits({ rate_limit: {
        primary_window: null,
        secondary_window: { ...PAYLOAD.rate_limit.secondary_window, used_percent: 0 },
    } }, NOW);
    expect(result?.windows).toEqual([
        { windowMinutes: 10_080, usedPercent: 0, resetsAt: (RESET + 86_400) * 1_000 },
    ]);
    expect(parseSubscriptionLimits({ rate_limit: {
        primary_window: { ...PAYLOAD.rate_limit.primary_window, used_percent: 100 },
    } }, NOW)?.windows[0]?.usedPercent).toBe(100);
});

test("the reader sends only access authorization and account selection to the usage endpoint", async () => {
    let requests = 0;
    const result = await readOpenAICodexLimits({
        authStorage: storage(undefined, "test-account"),
        now: () => NOW,
        fetch: (async (url, init) => {
            requests += 1;
            expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage");
            const headers = new Headers(init?.headers);
            expect(headers.get("Authorization")).toBe("Bearer test-access");
            expect(headers.get("ChatGPT-Account-Id")).toBe("test-account");
            expect(headers.get("Accept")).toBe("application/json");
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            expect(init?.redirect).toBe("error");
            expect(init?.body).toBeUndefined();
            return Response.json(PAYLOAD);
        }),
    });
    expect(requests).toBe(1);
    expect(result).toEqual(parseSubscriptionLimits(PAYLOAD, NOW));
    expect(JSON.stringify(result)).not.toContain("test-access");
    expect(JSON.stringify(result)).not.toContain("test-refresh");
    expect(JSON.stringify(result)).not.toContain("test-account");
});

test("missing, expired, corrupt, and unreadable credentials do not make a request", async () => {
    let requests = 0;
    const stores: Pick<AuthStorage, "getCredential">[] = [
        { getCredential: () => undefined },
        storage(NOW),
        { getCredential: () => ({ type: "oauth", token: "invalid" }) },
        { getCredential: () => { throw new Error("unreadable"); } },
    ];
    for (const authStorage of stores) {
        expect(await readOpenAICodexLimits({
            authStorage,
            now: () => NOW,
            fetch: (async () => { requests += 1; return Response.json(PAYLOAD); }),
        })).toBeNull();
    }
    expect(requests).toBe(0);
});

test("provider errors and invalid JSON return no subscription data", async () => {
    for (const response of [new Response("unauthorized", { status: 401 }), new Response("busy", { status: 503 }), new Response("invalid")]) {
        expect(await readOpenAICodexLimits({
            authStorage: storage(), now: () => NOW,
            fetch: (async () => response),
        })).toBeNull();
    }
    expect(await readOpenAICodexLimits({
        authStorage: storage(), now: () => NOW,
        fetch: (async () => { throw new Error("offline"); }),
    })).toBeNull();
});

test("concurrent reads and range changes share one request until the minute cache expires", async () => {
    let now = NOW;
    let requests = 0;
    let complete: ((response: Response) => void) | undefined;
    const read = createOpenAICodexLimitsReader({
        authStorage: storage(NOW + 86_400_000), now: () => now,
        fetch: (async () => {
            requests += 1;
            if (requests === 1) return new Promise<Response>((resolve) => { complete = resolve; });
            return Response.json(PAYLOAD);
        }),
    });
    const first = read();
    const second = read();
    expect(requests).toBe(1);
    complete?.(Response.json(PAYLOAD));
    expect(await first).toEqual(await second);
    await read();
    now += 59_999;
    await read();
    expect(requests).toBe(1);
    now += 1;
    await read();
    expect(requests).toBe(2);
});

test("a reset expires cached windows and a failed refresh hides them", async () => {
    let now = NOW;
    let requests = 0;
    const read = createOpenAICodexLimitsReader({
        authStorage: storage(NOW + 86_400_000), now: () => now,
        fetch: (async () => {
            requests += 1;
            if (requests > 1) return new Response("offline", { status: 503 });
            return Response.json({ rate_limit: {
                primary_window: { ...PAYLOAD.rate_limit.primary_window, reset_at: NOW / 1_000 + 10 },
            } });
        }),
    });
    expect(await read()).not.toBeNull();
    now += 10_000;
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(requests).toBe(2);
    now += 60_000;
    await read();
    expect(requests).toBe(3);
});

test("disconnecting or replacing the stored login never reuses the previous account cache", async () => {
    let credential = storage(NOW + 86_400_000, "first").getCredential(OPENAI_CODEX_PROVIDER_ID);
    let requests = 0;
    const read = createOpenAICodexLimitsReader({
        authStorage: { getCredential: () => credential }, now: () => NOW,
        fetch: (async () => { requests += 1; return Response.json(PAYLOAD); }),
    });
    await read();
    credential = undefined;
    expect(await read()).toBeNull();
    expect(requests).toBe(1);
    credential = storage(NOW + 86_400_000, "second").getCredential(OPENAI_CODEX_PROVIDER_ID);
    await read();
    expect(requests).toBe(2);
});

test("credential expiry hides cached values until the normal connection flow replaces the login", async () => {
    let now = NOW;
    let requests = 0;
    let authStorage = storage(NOW + 10_000);
    const read = createOpenAICodexLimitsReader({
        authStorage: { getCredential: (provider) => authStorage.getCredential(provider) },
        now: () => now,
        fetch: async () => { requests += 1; return Response.json(PAYLOAD); },
    });
    expect(await read()).not.toBeNull();
    now += 10_000;
    expect(await read()).toBeNull();
    expect(requests).toBe(1);
    authStorage = storage(NOW + 86_400_000);
    expect(await read()).not.toBeNull();
    expect(requests).toBe(2);
});

test("a stalled provider request times out and returns no subscription data", async () => {
    expect(await readOpenAICodexLimits({
        authStorage: storage(), now: () => NOW,
        fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    })).toBeNull();
}, 6_000);
