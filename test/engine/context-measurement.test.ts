import { expect, test } from "bun:test";

import {
    isContextMeasurement,
    measureProjectedRequest,
    measureReportedUsage,
} from "../../src/engine/context-measurement.ts";
import type { ProjectedModelRequest } from "../../src/engine/model-request.ts";
import type { ModelMessage, ModelTool } from "../../src/model/types.ts";
import { emptyUsage } from "../../src/model/types.ts";

test("the measurement counts everything the request carries, not just the chat", () => {
    const withoutTools = measureProjectedRequest(request({
        systemPrompt: "x".repeat(4_000),
    }));
    const withTools = measureProjectedRequest(request({
        systemPrompt: "x".repeat(4_000),
        tools: [tool()],
    }));

    // A client counting the transcript on screen would report these as equal.
    // The system prompt and the tool definitions occupy the window too, which
    // is why the engine is the only honest place to measure.
    expect(withoutTools.tokens).toBeGreaterThanOrEqual(1_000);
    expect(withTools.tokens).toBeGreaterThan(withoutTools.tokens);
});

test("the measurement grows with the transcript it will send", () => {
    const short = measureProjectedRequest(request({
        messages: [userMessage("hello")],
    }));
    const long = measureProjectedRequest(request({
        messages: [userMessage("hello"), userMessage("y".repeat(8_000))],
    }));

    expect(long.tokens - short.tokens).toBeGreaterThan(1_900);
});

test("a pre-request measurement travels labelled as an estimate", () => {
    // Vera ships no tokenizer, so nothing measured before a response is exact,
    // and a percentage that hid which it was would read as precise.
    expect(measureProjectedRequest(request({})).estimated).toBe(true);
    expect(measureReportedUsage({ ...emptyUsage(), inputTokens: 61_902 })
        ?.estimated).toBe(false);
});

test("capacity is carried only when the model's window is known", () => {
    expect(measureProjectedRequest(request({}), 258_000).capacity).toBe(258_000);
    expect(measureProjectedRequest(request({})).capacity).toBeUndefined();
    expect(measureReportedUsage(
        { ...emptyUsage(), inputTokens: 10 },
        131_072,
    )?.capacity).toBe(131_072);
});

test("a provider that reports no input tokens yields no measurement", () => {
    // Zero is absence, not a count of zero. Publishing it would drop the
    // status line to nothing after a turn that had just filled the window.
    expect(measureReportedUsage(emptyUsage())).toBeUndefined();
    expect(measureReportedUsage({ ...emptyUsage(), inputTokens: -1 }))
        .toBeUndefined();
});

test("tool results and tool calls are measured, not skipped", () => {
    const empty = measureProjectedRequest(request({ messages: [] }));
    const withToolRound = measureProjectedRequest(request({
        messages: [
            {
                role: "assistant",
                content: [{
                    type: "tool_call",
                    id: "call-1",
                    name: "bash",
                    input: { command: "z".repeat(2_000) },
                }],
                source: { provider: "faux", api: "test", model: "test" },
                usage: emptyUsage(),
                stopReason: "tool_use",
            },
            {
                role: "tool_result",
                toolCallId: "call-1",
                toolName: "bash",
                content: [{ type: "text", text: "w".repeat(2_000) }],
                isError: false,
            },
        ],
    }));

    // A long tool loop is where the window actually fills, so a measurement
    // blind to tool traffic would stay flat through the growth it exists to
    // report.
    expect(withToolRound.tokens - empty.tokens).toBeGreaterThan(900);
});

test("a measurement is rejected unless it says how it was arrived at", () => {
    expect(isContextMeasurement({ tokens: 10, estimated: true })).toBe(true);
    expect(isContextMeasurement({ tokens: 10, capacity: 20, estimated: false }))
        .toBe(true);
    expect(isContextMeasurement({ tokens: 10 })).toBe(false);
    expect(isContextMeasurement({ tokens: -1, estimated: true })).toBe(false);
    expect(isContextMeasurement({ tokens: 10, capacity: 0, estimated: true }))
        .toBe(false);
    expect(isContextMeasurement(undefined)).toBe(false);
});

function request(
    overrides: {
        systemPrompt?: string;
        messages?: readonly ModelMessage[];
        tools?: readonly ModelTool[];
    },
): ProjectedModelRequest {
    return {
        model: "test",
        maxTokens: 8_000,
        systemPrompt: overrides.systemPrompt ?? "",
        messages: overrides.messages ?? [],
        tools: overrides.tools ?? [],
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    };
}

function userMessage(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function tool(): ModelTool {
    return {
        name: "bash",
        description: "d".repeat(500),
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
    };
}
