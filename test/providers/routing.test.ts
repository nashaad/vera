import { expect, test } from "bun:test";

import { ProviderRoutingAdapter } from "../../src/providers/routing.ts";
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
                        source: { provider: "vera-strata", api: "test", model: request.model },
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
        "vera-strata",
        undefined,
        async (request) => ({
            ...request,
            bodyExtensions: { strata: { corpus_id: "corpus-1" } },
        }),
    );

    const result = await routing.stream({
        model: "strata",
        messages: [],
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(received).toEqual({ strata: { corpus_id: "corpus-1" } });
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
        "vera-strata",
        undefined,
        async (request) => request,
    );

    const result = await routing.stream({ model: "strata", messages: [] }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("without a terminal event");
});

test("an exception after a prepared stream's terminal event is ignored", async () => {
    const terminal = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        source: { provider: "vera-strata", api: "test", model: "strata" },
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
        "vera-strata",
        undefined,
        async (request) => request,
    );

    await expect(routing.stream({ model: "strata", messages: [] }).result())
        .resolves.toEqual(terminal);
});

test("preparation cancellation keeps the aborted stop reason", async () => {
    const controller = new AbortController();
    const routing = new ProviderRoutingAdapter(
        () => stubAdapter(),
        "vera-strata",
        undefined,
        async () => {
            controller.abort();
            throw controller.signal.reason;
        },
    );

    const result = await routing.stream({
        model: "strata",
        messages: [],
        signal: controller.signal,
    }).result();
    expect(result.stopReason).toBe("aborted");
});
