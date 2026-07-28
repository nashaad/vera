import { expect, test } from "bun:test";

import {
    COMPLETION_MAX_OUTPUT_TOKENS,
    createRoutedCompletionService,
    CompletionUnavailableError,
} from "../../src/engine/completion-service.ts";
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
