import { expect, test } from "bun:test";
import { configuredProviders } from "../../src/providers/registry.ts";
import type { SubscriptionLimits } from "../../src/providers/subscription-limits.ts";
import {
    readAnnexSubscriptionLimits,
    SubscriptionLimitsPoller,
    subscriptionLimitsText,
} from "../../clients/tui/subscription-limits.ts";

const provider = configuredProviders(undefined).find((item) => item.access === "subscription")!.id;

function limits(resetsAt = Date.now() + 60_000): SubscriptionLimits[] {
    return [{ provider, fetchedAt: Date.now(), windows: [
        { windowMinutes: 10_080, usedPercent: 9, resetsAt: resetsAt + 60_000 },
        { windowMinutes: 300, usedPercent: 58, resetsAt },
    ] }];
}

async function until(predicate: () => boolean): Promise<void> {
    for (let pass = 0; pass < 100; pass += 1) {
        if (predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error("condition did not become ready");
}

test("remaining windows are ordered, scoped to the selected provider, and hidden at reset", () => {
    const facts = limits(1_000);
    expect(subscriptionLimitsText(facts, provider, 999)).toBe("5h 42% left · week 91% left");
    expect(subscriptionLimitsText(facts, provider, 1_000)).toBe("week 91% left");
    expect(subscriptionLimitsText(facts, "other", 999)).toBe("");
    expect(subscriptionLimitsText(facts, provider, 61_000)).toBe("");
});

test("polling recovers from failure and skips providers without subscription access", async () => {
    let calls = 0;
    const poller = new SubscriptionLimitsPoller({
        read: async () => {
            calls += 1;
            if (calls === 2) throw new Error("unavailable");
            return limits();
        },
        onChange: () => {}, refreshMs: 20,
    });
    try {
        poller.selectProvider("other");
        expect(calls).toBe(0);
        poller.selectProvider(provider);
        await until(() => poller.text().includes("42%"));
        await until(() => calls === 2 && poller.text() === "");
        await until(() => calls >= 3 && poller.text().includes("42%"));
        poller.selectProvider("other");
        expect(poller.text()).toBe("");
        const count = calls;
        await Bun.sleep(30);
        expect(calls).toBe(count);
    } finally {
        poller.stop();
    }
});

test("provider switches and shutdown abort requests and ignore late results", async () => {
    const pending: Array<{ signal: AbortSignal; resolve: (value: SubscriptionLimits[]) => void }> = [];
    const poller = new SubscriptionLimitsPoller({
        read: (signal) => new Promise((resolve) => pending.push({ signal, resolve })),
        onChange: () => {},
    });
    poller.selectProvider(provider);
    poller.selectProvider("other");
    expect(pending[0]!.signal.aborted).toBe(true);
    poller.selectProvider(provider);
    pending[0]!.resolve(limits());
    await Bun.sleep(5);
    expect(poller.text()).toBe("");
    poller.stop();
    expect(pending[1]!.signal.aborted).toBe(true);
    pending[1]!.resolve(limits());
    await Bun.sleep(5);
    expect(poller.text()).toBe("");
});

test("a reset triggers refresh and hides the expired window while it is pending", async () => {
    let clock = 1_000;
    let calls = 0;
    const poller = new SubscriptionLimitsPoller({
        now: () => clock,
        read: async () => {
            calls += 1;
            if (calls > 1) return await new Promise<SubscriptionLimits[]>(() => {});
            return limits(1_020);
        },
        onChange: () => {},
    });
    try {
        poller.selectProvider(provider);
        await until(() => poller.text().includes("42%"));
        clock = 1_020;
        await until(() => calls === 2);
        expect(poller.text()).toBe("week 91% left");
    } finally {
        poller.stop();
    }
});

test("the annex reader validates numeric facts and hides unavailable responses", async () => {
    const facts = limits();
    let payload: unknown = { limits: facts };
    let status = 200;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/usage/subscriptions");
        return Response.json(payload, { status });
    } });
    try {
        const url = async () => ({ url: server.url.href });
        expect(await readAnnexSubscriptionLimits(url, new AbortController().signal)).toEqual(facts);
        payload = { limits: [{ provider, fetchedAt: 1, windows: [
            { windowMinutes: 300, usedPercent: 101, resetsAt: 10 },
        ] }, { provider, fetchedAt: "invalid", windows: [] }] };
        expect(await readAnnexSubscriptionLimits(url, new AbortController().signal)).toEqual([
            { provider, fetchedAt: 1, windows: [] },
        ]);
        status = 503;
        expect(await readAnnexSubscriptionLimits(url, new AbortController().signal)).toEqual([]);
        expect(await readAnnexSubscriptionLimits(async () => ({ unavailable: "offline" }), new AbortController().signal)).toEqual([]);
        const abort = new AbortController();
        abort.abort();
        expect(await readAnnexSubscriptionLimits(url, abort.signal)).toEqual([]);
    } finally {
        server.stop(true);
    }
});
