import { expect, test } from "bun:test";

import {
    adapterCacheFingerprint,
    createRequestOptionsSnapshotAdapter,
    ProviderRoutingAdapter,
} from "../../src/providers/routing.ts";
import type { ModelAdapter, ModelStream } from "../../src/model/types.ts";
import { ModelEventStream } from "../../src/model/stream.ts";

function stubAdapter(): ModelAdapter {
    return {
        stream: (): ModelStream => {
            throw new Error("not streamed in this test");
        },
    };
}

test("a provider's client is built once while its credentials hold still", () => {
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openai-codex",
        () => "same-key",
    );

    routing.prepareProvider("openrouter");
    routing.prepareProvider("openrouter");

    expect(built).toBe(1);
});

test("signing in again mid-session stops the old key from being spent", () => {
    // A client captures the credential it was built with, so a re-key that left
    // the cache alone would keep billing the key the user just replaced, with
    // nothing on screen to explain it.
    let fingerprint = "first-key";
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openai-codex",
        () => fingerprint,
    );

    routing.prepareProvider("openrouter");
    fingerprint = "second-key";
    routing.prepareProvider("openrouter");

    expect(built).toBe(2);
});

test("a live rewrite of a custom provider rebuilds the cached client", () => {
    let fingerprint: string | undefined = "\nfirst-url";
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openai-codex",
        () => fingerprint,
    );

    routing.prepareProvider("live-local");
    fingerprint = "\nsecond-url";
    routing.prepareProvider("live-local");
    fingerprint = undefined;
    expect(() => routing.prepareProvider("live-local")).not.toThrow();
    expect(built).toBe(3);
});

test("adapterCacheFingerprint follows the live declaration, not just the key", () => {
    const empty = {};
    expect(adapterCacheFingerprint(empty, undefined, "live-local")).toBeUndefined();
    expect(adapterCacheFingerprint(empty, "signed-in", "openrouter")).toBe("signed-in\n");

    const first = adapterCacheFingerprint({
        providers: {
            "live-local": {
                protocol: "openai-chat",
                credential: "none",
                base_url: "http://127.0.0.1:9/v1",
            },
        },
    }, undefined, "live-local");
    const moved = adapterCacheFingerprint({
        providers: {
            "live-local": {
                protocol: "openai-chat",
                credential: "none",
                base_url: "http://127.0.0.1:8/v1",
            },
        },
    }, undefined, "live-local");
    expect(first).toBeDefined();
    expect(moved).not.toBe(first);
    expect(adapterCacheFingerprint({ providers: {} }, undefined, "live-local"))
        .toBeUndefined();
});

test("nothing is built until something asks, including the default provider", () => {
    // The default provider used to be built while the agent was being created,
    // which meant a provider with no credential stopped Vera from starting at
    // all, and the connect pane that fixes it lives inside the TUI.
    let fingerprint: string | undefined = undefined;
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openrouter",
        () => fingerprint,
    );

    expect(built).toBe(0);

    routing.prepareProvider("openrouter");
    expect(built).toBe(1);

    // And it is still rebuilt on a re-key, like any other provider.
    fingerprint = "signed-in";
    routing.prepareProvider("openrouter");
    expect(built).toBe(2);
});

test("a host with no credential store keeps one client per provider", () => {
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openai-codex",
    );

    routing.prepareProvider("ollama");
    routing.prepareProvider("ollama");
    routing.prepareProvider("openai-codex");

    expect(built).toBe(2);
});

test("request preparation finishes before the provider sees the request", async () => {
    let received: Record<string, unknown> | undefined;
    let preparedPair: string | undefined;
    const routing = new ProviderRoutingAdapter(
        () => ({
            stream(request) {
                received = request.bodyExtensions;
                const stream = new ModelEventStream();
                stream.push({ type: "start" });
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "ok" }],
                        source: { provider: "vera-sample", api: "test", model: request.model },
                        usage: {
                            inputTokens: 0,
                            outputTokens: 0,
                            cachedInputTokens: 0,
                            reasoningTokens: 0,
                            totalTokens: 0,
                        },
                        stopReason: "stop",
                    },
                });
                return stream;
            },
        }),
        "vera-sample",
        undefined,
        async (request, provider) => {
            preparedPair = `${provider}/${request.model}`;
            return {
                ...request,
                bodyExtensions: { sample: { corpus_id: "corpus-1" } },
            };
        },
    );

    const result = await routing.stream({
        model: "sample",
        messages: [],
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(preparedPair).toBe("vera-sample/sample");
    expect(received).toEqual({ sample: { corpus_id: "corpus-1" } });
});

test("a retry reuses the request's originally prepared options", async () => {
    let currentOnly = "openai";
    let prepared = 0;
    const received: unknown[] = [];
    const routing = new ProviderRoutingAdapter(
        () => ({
            stream(request) {
                received.push(request.bodyExtensions);
                const stream = new ModelEventStream();
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [],
                        source: {
                            provider: "openrouter",
                            api: "test",
                            model: request.model,
                        },
                        usage: {
                            inputTokens: 0,
                            outputTokens: 0,
                            cachedInputTokens: 0,
                            reasoningTokens: 0,
                            totalTokens: 0,
                        },
                        stopReason: "stop",
                    },
                });
                return stream;
            },
        }),
        "openrouter",
        undefined,
        (request) => {
            prepared += 1;
            return {
                ...request,
                bodyExtensions: { provider: { only: [currentOnly] } },
            };
        },
    );
    const request = { model: "anthropic/claude-sonnet-4.5", messages: [] };

    await routing.stream(request).result();
    currentOnly = "anthropic";
    await routing.stream(request).result();

    expect(prepared).toBe(1);
    expect(received).toEqual([
        { provider: { only: ["openai"] } },
        { provider: { only: ["openai"] } },
    ]);
});

test("a bounded operation keeps one request-options snapshot across calls", async () => {
    const received: unknown[] = [];
    const adapter = createRequestOptionsSnapshotAdapter(
        () => ({
            stream(request) {
                received.push(request.bodyExtensions);
                const stream = new ModelEventStream();
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [],
                        source: {
                            provider: "openrouter",
                            api: "test",
                            model: request.model,
                        },
                        usage: {
                            inputTokens: 0,
                            outputTokens: 0,
                            cachedInputTokens: 0,
                            reasoningTokens: 0,
                            totalTokens: 0,
                        },
                        stopReason: "stop",
                    },
                });
                return stream;
            },
        }),
        "openrouter",
        {
            model_request_options: {
                "openrouter/test/model": {
                    body: { provider: { only: ["z-ai"] } },
                },
            },
        },
    );

    await adapter.stream({ model: "test/model", messages: [] }).result();
    await adapter.stream({ model: "test/model", messages: [] }).result();

    expect(received).toEqual([
        { provider: { only: ["z-ai"] } },
        { provider: { only: ["z-ai"] } },
    ]);
});

test("a request-body collision is one terminal failure before dispatch", async () => {
    let sent = false;
    const routing = new ProviderRoutingAdapter(
        () => ({
            stream() {
                sent = true;
                return new ModelEventStream();
            },
        }),
        "openrouter",
        undefined,
        async () => {
            throw new Error(
                'Model request body field "provider" is defined by both hook and profile',
            );
        },
    );

    const result = await routing.stream({
        model: "test/model",
        messages: [],
    }).result();

    expect(sent).toBe(false);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('field "provider"');
});

test("a prepared stream that ends early becomes a terminal error", async () => {
    const routing = new ProviderRoutingAdapter(
        () => ({
            stream: () => ({
                async *[Symbol.asyncIterator]() {
                    yield { type: "start" } as const;
                },
                result: () => new Promise(() => {}),
            }),
        }),
        "vera-sample",
        undefined,
        async (request) => request,
    );

    const result = await routing.stream({ model: "sample", messages: [] }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("without a terminal event");
});

test("an exception after a prepared stream's terminal event is ignored", async () => {
    const terminal = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        source: { provider: "vera-sample", api: "test", model: "sample" },
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
        },
        stopReason: "stop" as const,
    };
    const routing = new ProviderRoutingAdapter(
        () => ({
            stream: () => ({
                async *[Symbol.asyncIterator]() {
                    yield { type: "done" as const, message: terminal };
                    throw new Error("late iterator failure");
                },
                result: () => Promise.resolve(terminal),
            }),
        }),
        "vera-sample",
        undefined,
        async (request) => request,
    );

    await expect(routing.stream({ model: "sample", messages: [] }).result())
        .resolves.toEqual(terminal);
});

test("preparation cancellation keeps the aborted stop reason", async () => {
    const controller = new AbortController();
    const routing = new ProviderRoutingAdapter(
        () => stubAdapter(),
        "vera-sample",
        undefined,
        async () => {
            controller.abort();
            throw controller.signal.reason;
        },
    );

    const result = await routing.stream({
        model: "sample",
        messages: [],
        signal: controller.signal,
    }).result();
    expect(result.stopReason).toBe("aborted");
});
