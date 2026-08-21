import { expect, test } from "bun:test";

import {
    COMPLETION_MAX_OUTPUT_TOKENS,
    createRoutedCompletionService,
    CompletionUnavailableError,
} from "../../src/engine/completion-service.ts";
import {
    ProviderFailureError,
    type ProviderFailure,
} from "../../src/model/provider-failure.ts";
import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
} from "../../src/model/types.ts";
import { emptyUsage } from "../../src/model/types.ts";

test("the route is a preference list, so the second model answers when the first fails", async () => {
    const seen: string[] = [];
    const service = createRoutedCompletionService(
        adapter((request) => {
            seen.push(request.model);
            if (request.model === "first") {
                throw new Error("provider down");
            }
            return assistant("summary");
        }),
        { models: [{ model: "first" }, { model: "second" }] },
    );

    const result = await service(
        { systemPrompt: "s", messages: [] },
        new AbortController().signal,
    );

    expect(seen).toEqual(["first", "second"]);
    expect(result.text).toBe("summary");
    expect(result.model).toBe("second");
});

test("a truncated answer is refused rather than returned short", async () => {
    // A summary cut at the token ceiling reads as complete and silently loses
    // whatever came after the cut, which then never reaches the model again.
    const service = createRoutedCompletionService(
        adapter(() => assistant("half a sum", "length")),
        { models: [{ model: "only" }] },
    );

    await expect(
        service({ systemPrompt: "s", messages: [] }, new AbortController().signal),
    ).rejects.toBeInstanceOf(CompletionUnavailableError);
});

test("an empty answer is refused", async () => {
    const service = createRoutedCompletionService(
        adapter(() => assistant("   ")),
        { models: [{ model: "only" }] },
    );

    await expect(
        service({ systemPrompt: "s", messages: [] }, new AbortController().signal),
    ).rejects.toBeInstanceOf(CompletionUnavailableError);
});

test("the caller cannot ask for more output than the binding allows", async () => {
    let requested = 0;
    const service = createRoutedCompletionService(
        adapter((request) => {
            requested = request.maxTokens ?? 0;
            return assistant("ok");
        }),
        { models: [{ model: "only" }], maxOutputTokens: 100 },
    );

    await service(
        { systemPrompt: "s", messages: [], maxTokens: 1_000_000 },
        new AbortController().signal,
    );

    expect(requested).toBe(100);
    expect(COMPLETION_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
});

test("an exhausted route names every model that failed, not only the last", async () => {
    const service = createRoutedCompletionService(
        adapter((request) =>
            request.model === "first"
                ? assistant("cut", "length")
                : assistant("")
        ),
        { models: [{ model: "first" }, { model: "second" }] },
    );

    await expect(service(
        { systemPrompt: "s", messages: [] },
        new AbortController().signal,
    )).rejects.toThrow("first stopped with length; second returned no text");
});

test("a model that names a smaller output allowance is asked again at that allowance", async () => {
    const requested: number[] = [];
    const service = createRoutedCompletionService(
        adapter((request) => {
            requested.push(request.maxTokens ?? 0);
            if (requested.length === 1) {
                throw new ProviderFailureError({
                    kind: "invalid_request",
                    message: "max_tokens too large",
                    allowance: {
                        kind: "max_tokens",
                        requested: 32_768,
                        available: 8_000,
                    },
                } as ProviderFailure, undefined);
            }
            return assistant("ok");
        }),
        { models: [{ model: "only" }], maxOutputTokens: 32_768 },
    );

    const result = await service(
        { systemPrompt: "s", messages: [] },
        new AbortController().signal,
    );

    expect(result.text).toBe("ok");
    expect(requested).toEqual([32_768, 8_000]);
});

test("an empty route answers nothing rather than reaching for a default model", async () => {
    const service = createRoutedCompletionService(
        adapter(() => assistant("should not happen")),
        { models: [] },
    );

    await expect(
        service({ systemPrompt: "s", messages: [] }, new AbortController().signal),
    ).rejects.toBeInstanceOf(CompletionUnavailableError);
});

test("cancellation is reported as unavailable, not as an answer", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = createRoutedCompletionService(
        adapter(() => assistant("ignored")),
        { models: [{ model: "only" }] },
    );

    await expect(
        service({ systemPrompt: "s", messages: [] }, controller.signal),
    ).rejects.toBeInstanceOf(CompletionUnavailableError);
});

test("a model whose window cannot hold the request is skipped, and says so", async () => {
    // Sending it anyway spends a round trip to be told what the catalog
    // already knows, at the moment the session most needs the answer.
    const seen: string[] = [];
    const long = "x".repeat(200_000);
    const service = createRoutedCompletionService(
        adapter((request) => {
            seen.push(request.model);
            return assistant("summary");
        }),
        {
            models: [
                { model: "small", contextWindow: 8_000 },
                { model: "large", contextWindow: 200_000 },
            ],
            maxOutputTokens: 1_000,
        },
    );

    const result = await service({
        systemPrompt: "s",
        messages: [{ role: "user", content: [{ type: "text", text: long }] }],
    }, new AbortController().signal);

    expect(seen).toEqual(["large"]);
    expect(result.model).toBe("large");
});

test("a window skip is marked room related so a smaller request can retry", async () => {
    // The caller's ladder reads this: a shorter request is exactly what makes
    // the skipped candidate viable, so this failure is not the end of the road.
    const complete = createRoutedCompletionService(
        adapter(() => assistant("unused")),
        { models: [{ model: "small", contextWindow: 10 }] },
    );
    const error = await complete(
        { systemPrompt: "s".repeat(4_000), messages: [] },
        new AbortController().signal,
    ).then(() => undefined, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CompletionUnavailableError);
    expect((error as CompletionUnavailableError).roomRelated).toBe(true);
});

test("a failure that is not about room is not marked room related", async () => {
    const complete = createRoutedCompletionService(
        adapter(() => {
            throw new Error("no key");
        }),
        { models: [{ model: "plain" }] },
    );
    const error = await complete(
        { systemPrompt: "s", messages: [] },
        new AbortController().signal,
    ).then(() => undefined, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CompletionUnavailableError);
    expect((error as CompletionUnavailableError).roomRelated).toBe(false);
});

test("a route of windows that are all too small names the sizes it refused", async () => {
    const service = createRoutedCompletionService(
        adapter(() => assistant("should not happen")),
        { models: [{ model: "small", contextWindow: 10 }] },
    );

    await expect(service({
        systemPrompt: "s",
        messages: [{
            role: "user",
            content: [{ type: "text", text: "x".repeat(4_000) }],
        }],
    }, new AbortController().signal)).rejects.toThrow(
        /small skipped: the request is about \d+ tokens .*window is 10/,
    );
});

test("a model with no recorded window is tried rather than skipped", async () => {
    // Undefined is not a small window. A locally served model nobody has an
    // entry for must still be reachable.
    const service = createRoutedCompletionService(
        adapter(() => assistant("summary")),
        { models: [{ model: "unknown" }] },
    );

    const result = await service({
        systemPrompt: "s",
        messages: [{
            role: "user",
            content: [{ type: "text", text: "x".repeat(400_000) }],
        }],
    }, new AbortController().signal);

    expect(result.model).toBe("unknown");
});

test("a deadline is reported as a timeout, not as the model's stop reason", async () => {
    // An adapter that turns the deadline into an aborted message rather than
    // a throw would otherwise be reported as "stopped with aborted", which
    // names the symptom and hides the cause.
    const service = createRoutedCompletionService(
        {
            stream: () => ({
                [Symbol.asyncIterator]: async function* () {},
                result: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return assistant("", "aborted");
                },
            }),
        } as unknown as ModelAdapter,
        { models: [{ model: "slow" }], timeoutMs: 1 },
    );

    await expect(service(
        { systemPrompt: "s", messages: [] },
        new AbortController().signal,
    )).rejects.toThrow("slow timed out");
});

function adapter(
    respond: (request: ModelRequest) => AssistantMessage,
): ModelAdapter {
    return {
        stream: (request: ModelRequest) => {
            const message = respond(request);
            return {
                [Symbol.asyncIterator]: async function* () {},
                result: async () => message,
            };
        },
    } as unknown as ModelAdapter;
}

function assistant(
    text: string,
    stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
        source: { provider: "test", api: "scripted", model: "test" },
        usage: emptyUsage(),
    } as AssistantMessage;
}
