import { expect, test } from "bun:test";

import {
    DEFAULT_MODEL_MAX_TOKENS,
    ESCALATED_MODEL_MAX_TOKENS,
    LENGTH_CONTINUATION_PROMPT,
    MAX_LENGTH_CONTINUATIONS,
    nextLengthContinuation,
    requestModelWithRecovery,
    type ModelFallbackSelected,
    type ModelRetryScheduled,
} from "../../src/engine/recovery.ts";
import {
    ProviderFailureError,
    type ProviderFailure,
} from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ModelStreamEvent,
} from "../../src/model/types.ts";

const transientFailure: ProviderFailure = {
    kind: "connection",
    resolution: "retry",
    message: "temporary failure",
};

const overloadFailure: ProviderFailure = {
    kind: "server",
    resolution: "retry",
    message: "provider overloaded",
};

const malformedToolCallFailure: ProviderFailure = {
    kind: "unknown",
    resolution: "retry",
    message: "invalid JSON for tool call",
    partialOutputReplaceable: true,
};

test("length recovery raises the cap once and bounds continuations", () => {
    expect(nextLengthContinuation(DEFAULT_MODEL_MAX_TOKENS, 0)).toEqual({
        previousMaxTokens: DEFAULT_MODEL_MAX_TOKENS,
        nextMaxTokens: ESCALATED_MODEL_MAX_TOKENS,
        continuation: 1,
        maxContinuations: MAX_LENGTH_CONTINUATIONS,
        prompt: LENGTH_CONTINUATION_PROMPT,
    });
    expect(nextLengthContinuation(ESCALATED_MODEL_MAX_TOKENS, 2)).toEqual({
        previousMaxTokens: ESCALATED_MODEL_MAX_TOKENS,
        nextMaxTokens: ESCALATED_MODEL_MAX_TOKENS,
        continuation: 3,
        maxContinuations: MAX_LENGTH_CONTINUATIONS,
        prompt: LENGTH_CONTINUATION_PROMPT,
    });
    expect(nextLengthContinuation(
        ESCALATED_MODEL_MAX_TOKENS,
        MAX_LENGTH_CONTINUATIONS,
    )).toBeUndefined();
});

test("engine recovery retries a transient pre-content failure", async () => {
    const adapter = scriptedAdapter([
        (stream) => fail(stream, transientFailure),
        (stream) => succeed(stream, "complete"),
    ]);
    const events: ModelStreamEvent[] = [];
    const retries: ModelRetryScheduled[] = [];
    const delays: number[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "test", messages: [] },
        {
            onEvent: (event) => events.push(event),
            onRetry: (retry) => retries.push(retry),
            onFallback: () => {},
            wait: async (delayMs) => {
                delays.push(delayMs);
            },
        },
    );

    expect(result.content).toEqual([{ type: "text", text: "complete" }]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(retries).toEqual([{
        model: "test",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        failure: transientFailure,
    }]);
    expect(delays).toEqual([500]);
});

test("engine recovery stops after its retry budget", async () => {
    const adapter = scriptedAdapter([
        (stream) => fail(stream, transientFailure),
        (stream) => fail(stream, transientFailure),
        (stream) => fail(stream, transientFailure),
    ]);
    const events: ModelStreamEvent[] = [];
    const delays: number[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "test", messages: [] },
        {
            onEvent: (event) => events.push(event),
            onRetry: () => {},
            onFallback: () => {},
            wait: async (delayMs) => {
                delays.push(delayMs);
            },
        },
    );

    expect(result.stopReason).toBe("error");
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(delays).toEqual([500, 1_000]);
});

test("engine recovery selects a fallback after consecutive overloads", async () => {
    const models: string[] = [];
    const adapter = scriptedAdapter([
        (stream, request) => {
            models.push(request.model);
            fail(stream, overloadFailure);
        },
        (stream, request) => {
            models.push(request.model);
            fail(stream, overloadFailure);
        },
        (stream, request) => {
            models.push(request.model);
            succeed(stream, "fallback complete");
        },
    ]);
    const events: ModelStreamEvent[] = [];
    const retries: ModelRetryScheduled[] = [];
    const fallbacks: ModelFallbackSelected[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "primary", messages: [] },
        {
            fallback: { model: "backup", afterFailures: 2 },
            onEvent: (event) => events.push(event),
            onRetry: (retry) => retries.push(retry),
            onFallback: (fallback) => fallbacks.push(fallback),
            wait: async () => {},
        },
    );

    expect(result.content).toEqual([{
        type: "text",
        text: "fallback complete",
    }]);
    expect(models).toEqual(["primary", "primary", "backup"]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(retries).toHaveLength(1);
    expect(fallbacks).toEqual([{
        fromModel: "primary",
        toModel: "backup",
        afterFailures: 2,
        failure: overloadFailure,
    }]);
});

test("a fallback drops a reasoning effort its model cannot take", async () => {
    const requests: ModelRequest[] = [];
    const adapter = scriptedAdapter([
        (stream, request) => {
            requests.push(request);
            fail(stream, overloadFailure);
        },
        (stream, request) => {
            requests.push(request);
            fail(stream, overloadFailure);
        },
        (stream, request) => {
            requests.push(request);
            succeed(stream, "fallback complete");
        },
    ]);

    // The codex adapter throws for a model it has no reasoning profile for, so
    // carrying "high" across would turn a recoverable overload into a failure.
    await requestModelWithRecovery(
        adapter,
        {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            messages: [],
        },
        {
            fallback: { model: "gpt-5.6-codex", afterFailures: 2 },
            onEvent: () => {},
            onRetry: () => {},
            onFallback: () => {},
            wait: async () => {},
        },
    );

    expect(requests.map((request) => ({
        model: request.model,
        reasoningEffort: request.reasoningEffort,
    }))).toEqual([
        { model: "gpt-5.6-sol", reasoningEffort: "high" },
        { model: "gpt-5.6-sol", reasoningEffort: "high" },
        { model: "gpt-5.6-codex", reasoningEffort: undefined },
    ]);
});

test("engine recovery requires consecutive overloads for fallback", async () => {
    const adapter = scriptedAdapter([
        (stream) => fail(stream, overloadFailure),
        (stream) => fail(stream, transientFailure),
        (stream) => fail(stream, overloadFailure),
    ]);

    const result = await requestModelWithRecovery(
        adapter,
        { model: "primary", messages: [] },
        {
            fallback: { model: "backup", afterFailures: 2 },
            onEvent: () => {},
            onRetry: () => {},
            onFallback: () => {
                throw new Error("fallback should not be selected");
            },
            wait: async () => {},
        },
    );

    expect(result.stopReason).toBe("error");
});

test("engine recovery selects at most one fallback", async () => {
    const models: string[] = [];
    const adapter = scriptedAdapter([
        (stream, request) => {
            models.push(request.model);
            fail(stream, overloadFailure);
        },
        (stream, request) => {
            models.push(request.model);
            fail(stream, overloadFailure);
        },
        (stream, request) => {
            models.push(request.model);
            fail(stream, overloadFailure);
        },
        (stream, request) => {
            models.push(request.model);
            fail(stream, overloadFailure);
        },
    ]);
    const fallbacks: ModelFallbackSelected[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "primary", messages: [] },
        {
            fallback: { model: "backup", afterFailures: 1 },
            onEvent: () => {},
            onRetry: () => {},
            onFallback: (fallback) => fallbacks.push(fallback),
            wait: async () => {},
        },
    );

    expect(result.stopReason).toBe("error");
    expect(models).toEqual(["primary", "backup", "backup", "backup"]);
    expect(fallbacks).toHaveLength(1);
});

test("engine recovery returns a non-retryable failure immediately", async () => {
    const failure: ProviderFailure = {
        kind: "invalid_request",
        resolution: "user_action",
        message: "invalid request",
    };
    const adapter = scriptedAdapter([
        (stream) => fail(stream, failure),
    ]);
    const events: ModelStreamEvent[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "test", messages: [] },
        {
            onEvent: (event) => events.push(event),
            onRetry: () => {
                throw new Error("retry should not be scheduled");
            },
            onFallback: () => {
                throw new Error("fallback should not be selected");
            },
            wait: async () => {
                throw new Error("wait should not be called");
            },
        },
    );

    expect(result.stopReason).toBe("error");
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
});

test("engine recovery never retries or falls back after content starts", async () => {
    const adapter = scriptedAdapter([
        (stream) => {
            stream.push({ type: "text_start", contentIndex: 0 });
            stream.push({
                type: "text_delta",
                contentIndex: 0,
                text: "partial",
            });
            fail(stream, overloadFailure, "partial");
        },
    ]);
    const events: ModelStreamEvent[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "primary", messages: [] },
        {
            fallback: { model: "backup", afterFailures: 1 },
            onEvent: (event) => events.push(event),
            onRetry: () => {
                throw new Error("retry should not be scheduled");
            },
            onFallback: () => {
                throw new Error("fallback should not be selected");
            },
            wait: async () => {
                throw new Error("wait should not be called");
            },
        },
    );

    expect(result.content).toEqual([{ type: "text", text: "partial" }]);
    expect(events.map((event) => event.type)).toEqual([
        "start",
        "text_start",
        "text_delta",
        "error",
    ]);
});

test("engine recovery replaces partial output for a discard-safe failure", async () => {
    const adapter = scriptedAdapter([
        (stream) => {
            stream.push({ type: "text_start", contentIndex: 0 });
            stream.push({
                type: "text_delta",
                contentIndex: 0,
                text: "partial",
            });
            fail(stream, malformedToolCallFailure, "partial");
        },
        (stream) => succeed(stream, "complete"),
    ]);
    const events: ModelStreamEvent[] = [];
    const retries: ModelRetryScheduled[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "primary", messages: [] },
        {
            onEvent: (event) => events.push(event),
            onRetry: (retry) => retries.push(retry),
            onFallback: () => {},
            wait: async () => {},
        },
    );

    expect(result.content).toEqual([{ type: "text", text: "complete" }]);
    expect(events.map((event) => event.type)).toEqual([
        "start",
        "text_start",
        "text_delta",
        "done",
    ]);
    expect(retries).toEqual([{
        model: "primary",
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        failure: malformedToolCallFailure,
        replacesPartialAttempt: true,
    }]);
});

test("discard-safe partial output ends visibly after retry exhaustion", async () => {
    const adapter = scriptedAdapter(["one", "two", "last"].map((text) =>
        (stream: ModelEventStream) => {
            stream.push({ type: "text_start", contentIndex: 0 });
            stream.push({ type: "text_delta", contentIndex: 0, text });
            fail(stream, malformedToolCallFailure, text);
        }
    ));
    const retries: ModelRetryScheduled[] = [];
    const events: ModelStreamEvent[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "primary", messages: [] },
        {
            onEvent: (event) => events.push(event),
            onRetry: (retry) => retries.push(retry),
            onFallback: () => {},
            wait: async () => {},
        },
    );

    expect(result).toMatchObject({
        stopReason: "error",
        content: [{ type: "text", text: "last" }],
    });
    expect(retries).toHaveLength(2);
    expect(retries.every((retry) => retry.replacesPartialAttempt === true))
        .toBe(true);
    expect(events.at(-1)?.type).toBe("error");
});

test("engine recovery aborts a pending backoff", async () => {
    const controller = new AbortController();
    const adapter = scriptedAdapter([
        (stream) => fail(stream, transientFailure),
    ]);
    const events: ModelStreamEvent[] = [];
    const retries: ModelRetryScheduled[] = [];
    const result = requestModelWithRecovery(
        adapter,
        { model: "test", messages: [], signal: controller.signal },
        {
            onEvent: (event) => events.push(event),
            onRetry: (retry) => retries.push(retry),
            onFallback: () => {},
        },
    );

    setTimeout(() => controller.abort(new Error("stop now")), 0);

    await expect(result).resolves.toMatchObject({
        stopReason: "aborted",
        errorMessage: "stop now",
    });
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(retries).toHaveLength(1);
});

test("engine recovery does not retry when a custom backoff resolves after abort", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const adapter = scriptedAdapter([
        (stream) => {
            attempts += 1;
            fail(stream, transientFailure);
        },
    ]);

    const result = await requestModelWithRecovery(
        adapter,
        { model: "test", messages: [], signal: controller.signal },
        {
            onEvent: () => {},
            onRetry: () => {},
            onFallback: () => {},
            wait: async () => {
                controller.abort(new Error("stop now"));
            },
        },
    );

    expect(result).toMatchObject({
        stopReason: "aborted",
        errorMessage: "stop now",
    });
    expect(attempts).toBe(1);
});

test("engine recovery does not select fallback after abort", async () => {
    const controller = new AbortController();
    const models: string[] = [];
    const adapter = scriptedAdapter([
        (stream, request) => {
            models.push(request.model);
            controller.abort(new Error("stop now"));
            fail(stream, overloadFailure);
        },
    ]);

    const result = await requestModelWithRecovery(
        adapter,
        { model: "primary", messages: [], signal: controller.signal },
        {
            fallback: { model: "backup", afterFailures: 1 },
            onEvent: () => {},
            onRetry: () => {
                throw new Error("retry should not be scheduled");
            },
            onFallback: () => {
                throw new Error("fallback should not be selected");
            },
        },
    );

    expect(result).toMatchObject({
        stopReason: "aborted",
        errorMessage: "stop now",
    });
    expect(models).toEqual(["primary"]);
});

function scriptedAdapter(
    attempts: Array<(
        stream: ModelEventStream,
        request: ModelRequest,
    ) => void>,
): ModelAdapter {
    return {
        stream(request): ModelEventStream {
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            const attempt = attempts.shift();
            if (attempt === undefined) {
                throw new Error("No scripted model attempt remains");
            }
            attempt(stream, request);
            return stream;
        },
    };
}

function succeed(stream: ModelEventStream, text: string): void {
    stream.push({ type: "done", message: assistant(text, "stop") });
}

function fail(
    stream: ModelEventStream,
    failure: ProviderFailure,
    text = "",
): void {
    const error = new ProviderFailureError(failure, new Error(failure.message));
    stream.push({
        type: "error",
        error,
        message: assistant(text, "error", error.message),
    });
}

function assistant(
    text: string,
    stopReason: "stop" | "error",
    errorMessage?: string,
): AssistantMessage {
    return {
        role: "assistant",
        content: text === "" ? [] : [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
    };
}
