import { expect, test } from "bun:test";

import { FauxAdapter } from "../../src/model/faux.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";

test("faux adapter streams scripted blocks in deterministic chunks", async () => {
    const response: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "text", text: "hello" },
            { type: "tool_call", id: "call_1", name: "read", input: { path: "a" } },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const adapter = new FauxAdapter([response], { chunkSize: 2 });
    const stream = adapter.stream({ model: "test", messages: [] });
    const eventTypes: string[] = [];
    const textDeltas: string[] = [];

    for await (const event of stream) {
        eventTypes.push(event.type);
        if (event.type === "text_delta") {
            textDeltas.push(event.text);
        }
    }

    expect(textDeltas).toEqual(["he", "ll", "o"]);
    expect(eventTypes).toEqual([
        "start",
        "text_start",
        "text_delta",
        "text_delta",
        "text_delta",
        "text_end",
        "tool_call_start",
        "tool_call_delta",
        "tool_call_delta",
        "tool_call_delta",
        "tool_call_delta",
        "tool_call_delta",
        "tool_call_delta",
        "tool_call_end",
        "done",
    ]);
    expect(await stream.result()).toEqual(response);
});

test("faux adapter returns a structured aborted result", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop now"));
    const adapter = new FauxAdapter([
        {
            role: "assistant",
            content: [{ type: "text", text: "unseen" }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ]);
    const stream = adapter.stream({
        model: "test",
        messages: [],
        signal: controller.signal,
    });

    const events = [];
    for await (const event of stream) {
        events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect((await stream.result()).stopReason).toBe("aborted");

    const retry = adapter.stream({ model: "test", messages: [] });
    for await (const _event of retry) {
        // Drain the stream.
    }
    expect((await retry.result()).content).toEqual([{ type: "text", text: "unseen" }]);
});

test("faux adapter rejects invalid chunk sizes", () => {
    expect(() => new FauxAdapter([], { chunkSize: 0 })).toThrow(
        "Faux adapter chunkSize must be a positive integer",
    );
});

test("faux adapter only returns content emitted before an abort", async () => {
    const controller = new AbortController();
    const adapter = new FauxAdapter(
        [
            {
                role: "assistant",
                content: [{ type: "text", text: "hello" }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        ],
        { chunkSize: 2, delayMs: 5 },
    );
    const stream = adapter.stream({
        model: "test",
        messages: [],
        signal: controller.signal,
    });

    const eventTypes: string[] = [];
    for await (const event of stream) {
        eventTypes.push(event.type);
        if (event.type === "text_delta") {
            controller.abort(new Error("stop now"));
        }
    }

    expect(eventTypes).toEqual(["start", "text_start", "text_delta", "error"]);
    expect((await stream.result()).content).toEqual([{ type: "text", text: "he" }]);
});
