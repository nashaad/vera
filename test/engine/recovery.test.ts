import { expect, test } from "bun:test";

import { requestModelWithRecovery } from "../../src/engine/recovery.ts";
import {
    ProviderFailureError,
    type ProviderFailure,
} from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelStreamEvent,
} from "../../src/model/types.ts";

const transientFailure: ProviderFailure = {
    kind: "connection",
    resolution: "retry",
    message: "temporary failure",
};

test("engine recovery retries a transient pre-content failure", async () => {
    const adapter = scriptedAdapter([
        (stream) => fail(stream, transientFailure),
        (stream) => succeed(stream, "complete"),
    ]);
    const events: ModelStreamEvent[] = [];
    const retries: unknown[] = [];
    const delays: number[] = [];

    const result = await requestModelWithRecovery(
        adapter,
        { model: "test", messages: [] },
        {
            onEvent: (event) => events.push(event),
            onRetry: (retry) => retries.push(retry),
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
            wait: async (delayMs) => {
                delays.push(delayMs);
            },
        },
    );

    expect(result.stopReason).toBe("error");
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(delays).toEqual([500, 1_000]);
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
            wait: async () => {
                throw new Error("wait should not be called");
            },
        },
    );

    expect(result.stopReason).toBe("error");
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
});

test("engine recovery never retries after content starts", async () => {
    const adapter = scriptedAdapter([
        (stream) => {
            stream.push({ type: "text_start", contentIndex: 0 });
            stream.push({
                type: "text_delta",
                contentIndex: 0,
                text: "partial",
            });
            fail(stream, transientFailure, "partial");
        },
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

test("engine recovery aborts a pending backoff", async () => {
    const controller = new AbortController();
    const adapter = scriptedAdapter([
        (stream) => fail(stream, transientFailure),
    ]);
    const events: ModelStreamEvent[] = [];
    const retries: unknown[] = [];
    const result = requestModelWithRecovery(
        adapter,
        { model: "test", messages: [], signal: controller.signal },
        {
            onEvent: (event) => events.push(event),
            onRetry: (retry) => retries.push(retry),
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

function scriptedAdapter(
    attempts: Array<(stream: ModelEventStream) => void>,
): ModelAdapter {
    return {
        stream(): ModelEventStream {
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            const attempt = attempts.shift();
            if (attempt === undefined) {
                throw new Error("No scripted model attempt remains");
            }
            attempt(stream);
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
