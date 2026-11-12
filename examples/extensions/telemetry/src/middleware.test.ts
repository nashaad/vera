import { describe, expect, test } from "bun:test";

import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
    ModelStream,
    ModelStreamEvent,
} from "../../../../src/model/types.ts";
import type { ModelAdapterContext } from "../../../../src/sdk/model-middleware.ts";
import type { SessionEndHookPayload } from "../../../../src/sdk/hooks.ts";

import { DEFAULT_CACHE_MISS, type CacheMissSettings } from "./cache-rule.ts";
import type { CacheMissEvent, ModelCallEvent, SessionEndEvent, TelemetryEvent } from "./events.ts";
import { telemetryHandlers } from "./middleware.ts";

const CONTEXT: ModelAdapterContext = {
    sessionId: "session-1",
    sessionPath: "/workspace/session-1.jsonl",
    workspace: "/workspace",
    provider: "rookery",
    purpose: "turn",
};

const MESSAGE: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "aye" }],
    source: { provider: "rookery", api: "chat", model: "crow-test" },
    usage: {
        inputTokens: 5_000,
        outputTokens: 10,
        cachedInputTokens: 4_000,
        reasoningTokens: 0,
        totalTokens: 5_010,
    },
    stopReason: "stop",
};

function userMessage(text: string): ModelRequest["messages"][number] {
    return { role: "user", content: [{ type: "text", text }] };
}

function reply(text: string): AssistantMessage {
    return { ...MESSAGE, content: [{ type: "text", text }] };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
    return {
        model: "requested-model",
        systemPrompt: "plot a course",
        messages: [userMessage("hi")],
        tools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
        ...overrides,
    };
}

function fakeStream(
    events: readonly ModelStreamEvent[],
    result: AssistantMessage | Error = MESSAGE,
): ModelStream {
    let index = 0;
    return {
        [Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
            return {
                async next(): Promise<IteratorResult<ModelStreamEvent>> {
                    if (index >= events.length) return { value: undefined, done: true };
                    const value = events[index]!;
                    index += 1;
                    return { value, done: false };
                },
            };
        },
        async result() {
            if (result instanceof Error) throw result;
            return result;
        },
    };
}

function failingStream(error: Error, after: readonly ModelStreamEvent[] = []): ModelStream {
    let index = 0;
    return {
        [Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
            return {
                async next(): Promise<IteratorResult<ModelStreamEvent>> {
                    if (index < after.length) {
                        const value = after[index]!;
                        index += 1;
                        return { value, done: false };
                    }
                    throw error;
                },
            };
        },
        async result() {
            throw error;
        },
    };
}

function adapterFor(
    stream: (request: ModelRequest) => ModelStream,
    methods: Partial<ModelAdapter> = {},
): ModelAdapter {
    return { stream, ...methods };
}

interface Harness {
    readonly events: TelemetryEvent[];
    readonly handlers: ReturnType<typeof telemetryHandlers>;
}

function harness(cacheMiss: CacheMissSettings = DEFAULT_CACHE_MISS): Harness {
    const events: TelemetryEvent[] = [];
    return {
        events,
        handlers: telemetryHandlers({
            context: { install_id: "install-1" },
            cacheMiss,
            emit: (event) => events.push(event),
        }),
    };
}

async function drain(stream: ModelStream): Promise<ModelStreamEvent[]> {
    const seen: ModelStreamEvent[] = [];
    for await (const event of stream) seen.push(event);
    return seen;
}

function calls(events: readonly TelemetryEvent[]): ModelCallEvent[] {
    return events.filter((event): event is ModelCallEvent => event.event === "model_call");
}

function misses(events: readonly TelemetryEvent[]): CacheMissEvent[] {
    return events.filter((event): event is CacheMissEvent => event.event === "cache_miss");
}

function ends(events: readonly TelemetryEvent[]): SessionEndEvent[] {
    return events.filter((event): event is SessionEndEvent => event.event === "session_end");
}

function sessionEnd(sessionId: string, reason: SessionEndHookPayload["reason"]): SessionEndHookPayload {
    return { type: "session_end", sessionId, workspace: "/workspace", reason, turns: 0, spawned: false };
}

describe("stream pass-through", () => {
    test("every event reaches the caller unchanged", async () => {
        const start: ModelStreamEvent = { type: "start" };
        const delta: ModelStreamEvent = { type: "text_delta", contentIndex: 0, text: "aye" };
        const done: ModelStreamEvent = { type: "done", message: MESSAGE };
        const { handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([start, delta, done])), CONTEXT);

        const seen = await drain(wrapped.stream(request()));
        expect(seen).toHaveLength(3);
        expect(seen[0]).toBe(start);
        expect(seen[1]).toBe(delta);
        expect(seen[2]).toBe(done);
    });

    test("result() resolves with the adapter's message", async () => {
        const { handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([])), CONTEXT);
        expect(await wrapped.stream(request()).result()).toEqual(MESSAGE);
    });

    test("a seen done event and a later result() record the call once", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(
            adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])),
            CONTEXT,
        );
        const stream = wrapped.stream(request());
        await drain(stream);
        await stream.result();
        expect(calls(events)).toHaveLength(1);
    });

    test("an error event passes through and is recorded as a failure", async () => {
        const error = new Error("provider said no");
        const event: ModelStreamEvent = {
            type: "error",
            error,
            message: { ...MESSAGE, stopReason: "error" },
        };
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([event], error)), CONTEXT);

        const seen = await drain(wrapped.stream(request()));
        expect(seen[0]).toBe(event);
        expect(calls(events)[0]).toMatchObject({
            stop_reason: "error",
            error: "provider said no",
            input_tokens: 5_000,
        });
    });

    test("a throwing iterator passes its error on and records the failure", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(
            adapterFor(() => failingStream(new Error("connection reset"))),
            CONTEXT,
        );
        await expect(drain(wrapped.stream(request()))).rejects.toThrow("connection reset");
        expect(calls(events)[0]).toMatchObject({ stop_reason: "error", error: "connection reset" });
    });

    test("an aborted stream is recorded as aborted, with no error text", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([])), CONTEXT);
        const signal = AbortSignal.abort();
        await drain(wrapped.stream(request({ signal })));

        const call = calls(events)[0]!;
        expect(call.stop_reason).toBe("aborted");
        expect(call).not.toHaveProperty("error");
    });

    test("an aborted throw carries no error text", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => failingStream(new Error("aborted"))), CONTEXT);
        const signal = AbortSignal.abort();
        await expect(drain(wrapped.stream(request({ signal })))).rejects.toThrow("aborted");
        expect(calls(events)[0]!.stop_reason).toBe("aborted");
        expect(calls(events)[0]).not.toHaveProperty("error");
    });

    test("a rejected result() is recorded without ever being iterated", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([], new Error("no route"))), CONTEXT);
        await expect(wrapped.stream(request()).result()).rejects.toThrow("no route");
        expect(calls(events)[0]).toMatchObject({ stop_reason: "error", error: "no route" });
    });

    test("a stream that ends without a result is recorded as a failure", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([])), CONTEXT);
        expect(await drain(wrapped.stream(request()))).toEqual([]);
        expect(calls(events)[0]).toMatchObject({
            stop_reason: "error",
            error: "model stream ended without a result",
        });
    });

    test("an adapter that throws before streaming still throws to the caller", () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => {
            throw new Error("cannot start");
        }), CONTEXT);
        expect(() => wrapped.stream(request())).toThrow("cannot start");
        expect(events).toHaveLength(0);
    });

    test("a throwing sink changes nothing about the stream", async () => {
        const start: ModelStreamEvent = { type: "start" };
        const done: ModelStreamEvent = { type: "done", message: MESSAGE };
        const handlers = telemetryHandlers({
            context: { install_id: "install-1" },
            cacheMiss: DEFAULT_CACHE_MISS,
            emit: () => {
                throw new Error("sink is down");
            },
        });
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([start, done])), CONTEXT);

        const seen = await drain(wrapped.stream(request()));
        expect(seen).toEqual([start, done]);
        expect(await wrapped.stream(request()).result()).toEqual(MESSAGE);
    });

    test("the adapter's optional methods survive the wrapper", () => {
        const { handlers } = harness();
        const adapter = adapterFor(() => fakeStream([]), {
            supportsImageInput: true,
            imageInputSupport: (model) => model === "vision",
            supportsImageInputFor: (provider, model) => provider === "rookery" && model === "vision",
        });
        const wrapped = handlers.middleware(adapter, CONTEXT);
        expect(wrapped.supportsImageInput).toBe(true);
        expect(wrapped.imageInputSupport?.("vision")).toBe(true);
        expect(wrapped.imageInputSupport?.("text-only")).toBe(false);
        expect(wrapped.supportsImageInputFor?.("rookery", "vision")).toBe(true);

        const bare = handlers.middleware(adapterFor(() => fakeStream([])), CONTEXT);
        expect("supportsImageInput" in bare).toBe(false);
        expect("imageInputSupport" in bare).toBe(false);
        expect("supportsImageInputFor" in bare).toBe(false);
    });
});

describe("model_call facts", () => {
    test("counts, hashes and cache fields come from the request and the reply", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])), CONTEXT);
        await drain(wrapped.stream(request({
            cacheKey: "conversation-key",
            cacheRetention: "long",
            messages: [
                userMessage("one"),
                reply("two"),
                userMessage("three"),
                reply("four"),
                userMessage("five"),
            ],
            tools: [
                { name: "a", description: "first", inputSchema: { type: "object" } },
                { name: "b", description: "second", inputSchema: { type: "object" } },
                { name: "c", description: "third", inputSchema: { type: "object" } },
            ],
        })));

        const call = calls(events)[0]!;
        expect(call).toMatchObject({
            session_id: "session-1",
            provider: "rookery",
            model: "crow-test",
            purpose: "turn",
            input_tokens: 5_000,
            cached_input_tokens: 4_000,
            output_tokens: 10,
            stop_reason: "stop",
            cache_retention: "long",
            has_cache_key: true,
            message_count: 5,
            tool_count: 3,
        });
        expect(call.system_hash).toMatch(/^[0-9a-f]{12}$/);
        expect(call.tools_hash).toMatch(/^[0-9a-f]{12}$/);
        expect(call.message_hashes).toHaveLength(4);
        expect(call.latency_ms).toBeGreaterThanOrEqual(0);
    });

    test("reports the model the provider answered with, not the one requested", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])), CONTEXT);
        await drain(wrapped.stream(request({ model: "requested-model" })));
        expect(calls(events)[0]!.model).toBe("crow-test");
    });

    test("defaults an unstated retention to short", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])), CONTEXT);
        await drain(wrapped.stream(request()));
        expect(calls(events)[0]!.cache_retention).toBe("short");
        expect(calls(events)[0]!.has_cache_key).toBe(false);
    });

    test("names the part of the prefix that changed between calls", async () => {
        const { events, handlers } = harness();
        const first = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])), CONTEXT);
        await drain(first.stream(request()));
        const second = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])), CONTEXT);
        await drain(second.stream(request({ systemPrompt: "new orders" })));

        expect(calls(events).map((call) => call.prefix_changed)).toEqual([null, "system"]);
    });

    test("a user question purpose is recorded as ask", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(
            adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])),
            { ...CONTEXT, purpose: "ask" },
        );
        await drain(wrapped.stream(request()));
        expect(calls(events)[0]!.purpose).toBe("ask");
    });
});

describe("cache misses", () => {
    const lowest = { min_reread_tokens: 100, min_share: 0.5 };

    test("emits cache_miss beside the model call when the rule fires", async () => {
        const { events, handlers } = harness(lowest);
        const first = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])), CONTEXT);
        await drain(first.stream(request()));
        expect(misses(events)).toHaveLength(0);

        const reRead: AssistantMessage = {
            ...MESSAGE,
            usage: {
                inputTokens: 5_000,
                outputTokens: 10,
                cachedInputTokens: 100,
                reasoningTokens: 0,
                totalTokens: 5_010,
            },
        };
        const second = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: reRead }])), CONTEXT);
        await drain(second.stream(request()));

        expect(calls(events)).toHaveLength(2);
        expect(misses(events)).toHaveLength(1);
        expect(misses(events)[0]).toMatchObject({
            input_tokens: 5_000,
            cached_input_tokens: 100,
            previous_input_tokens: 5_000,
            previous_cached_input_tokens: 4_000,
            reread_tokens: 4_900,
            prefix_changed: null,
        });
    });

    test("does not emit cache_miss when the prompt was cut since the last call", async () => {
        const { events, handlers } = harness(lowest);
        const first = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])), CONTEXT);
        await drain(first.stream(request()));

        const compacted: AssistantMessage = {
            ...MESSAGE,
            usage: {
                inputTokens: 1_000,
                outputTokens: 10,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 1_010,
            },
        };
        const second = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: compacted }])), CONTEXT);
        await drain(second.stream(request()));

        expect(calls(events)).toHaveLength(2);
        expect(misses(events)).toHaveLength(0);
    });
});

describe("session end", () => {
    test("repeats the last call's provider and model", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])), CONTEXT);
        await drain(wrapped.stream(request()));
        handlers.sessionEnded(sessionEnd("session-1", "closed"));

        expect(ends(events)[0]).toMatchObject({
            event: "session_end",
            session_id: "session-1",
            provider: "rookery",
            model: "crow-test",
            reason: "closed",
        });
    });

    test("keeps the parent session id when the host named one", async () => {
        const { events, handlers } = harness();
        const wrapped = handlers.middleware(
            adapterFor(() => fakeStream([{ type: "done", message: MESSAGE }])),
            { ...CONTEXT, parentSessionId: "parent-1" },
        );
        await drain(wrapped.stream(request()));
        handlers.sessionEnded(sessionEnd("session-1", "shutdown"));
        expect(ends(events)[0]!.parent_session_id).toBe("parent-1");
    });

    test("a session that made no call ends with empty session facts", () => {
        const { events, handlers } = harness();
        handlers.sessionEnded(sessionEnd("never-called", "idle"));
        expect(ends(events)[0]).toMatchObject({
            session_id: "never-called",
            provider: "",
            model: "",
            reason: "idle",
        });
    });
});
