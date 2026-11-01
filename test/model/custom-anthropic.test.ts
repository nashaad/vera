import { expect, test } from "bun:test";

import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import type {
    AssistantMessage,
    ModelInputMessage,
    ModelUsage,
} from "../../src/model/types.ts";

test("a named Anthropic endpoint streams signed thinking and tool use", async () => {
    const requests: Request[] = [];
    let call = 0;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "lab-anthropic",
        model: "claude-test",
        approval_mode: "ask",
        providers: {
            "lab-anthropic": {
                protocol: "anthropic-messages",
                base_url: "https://models.example.com/v1",
                credential: "api_key",
                api_key_env: "LAB_ANTHROPIC_KEY",
                max_tokens: 16_000,
                thinking: "adaptive",
            },
        },
    }, {
        env: { LAB_ANTHROPIC_KEY: "anthropic-secret" },
        fetch: async (input, init) => {
            requests.push(new Request(String(input), init));
            call += 1;
            if (call === 2) {
                return anthropicStream([
                    { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 12 } } },
                    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
                    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
                    { type: "message_stop" },
                ]);
            }
            return anthropicStream([
                { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 9 } } },
                { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check" } },
                { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-check" } },
                { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "read_file", input: {} } },
                { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } },
                { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
                { type: "message_stop" },
            ]);
        },
    });

    const first = await adapter.stream({
        model: "claude-test",
        systemPrompt: "Be precise.",
        messages: [{ role: "user", content: [{ type: "text", text: "Read it." }] }],
        tools: [{
            name: "read_file",
            description: "Read one file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
        }],
        reasoningEffort: "medium",
    }).result();

    expect(first).toMatchObject({
        content: [
            { type: "thinking", text: "check" },
            { type: "tool_call", id: "tool_1", name: "read_file", input: { path: "README.md" } },
        ],
        source: { provider: "lab-anthropic", api: "anthropic-messages" },
        stopReason: "tool_use",
    });
    expect(first.content[0]).toEqual({
        type: "thinking",
        text: "check",
        signature: JSON.stringify([{
            type: "reasoning.text",
            index: 0,
            format: "anthropic-claude-v1",
            text: "check",
            signature: "signed-check",
        }]),
    });

    const second = await adapter.stream({
        model: "claude-test",
        messages: [
            { role: "user", content: [{ type: "text", text: "Read it." }] },
            first as AssistantMessage,
            {
                role: "tool_result",
                toolCallId: "tool_1",
                toolName: "read_file",
                content: [{ type: "text", text: "hello" }],
                isError: false,
            },
        ],
    }).result();
    expect(second.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(2);

    expect(requests[0]?.url).toBe("https://models.example.com/v1/messages");
    expect(requests[0]?.headers.get("x-api-key")).toBe("anthropic-secret");
    expect(await requests[0]?.json()).toMatchObject({
        system: [{ type: "text", text: "Be precise.", cache_control: { type: "ephemeral" } }],
        model: "claude-test",
        stream: true,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        tools: [{ name: "read_file", cache_control: { type: "ephemeral" } }],
        messages: [{
            role: "user",
            content: [{ type: "text", text: "Read it.", cache_control: { type: "ephemeral" } }],
        }],
    });
    const continuation = await requests[1]?.json() as {
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(continuation.messages[1]?.content[0]).toMatchObject({
        type: "thinking",
        thinking: "check",
        signature: "signed-check",
    });
    expect(continuation.messages[2]?.content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "tool_1",
    });

    await adapter.stream({
        model: "claude-test",
        messages: [{ role: "user", content: [{ type: "text", text: "Direct." }] }],
        reasoningEffort: "off",
    }).result();
    const offRequest = await requests[2]?.json() as Record<string, unknown>;
    expect(offRequest.thinking).toBeUndefined();
    expect(offRequest.output_config).toBeUndefined();

    await adapter.stream({
        model: "claude-test",
        messages: [{ role: "user", content: [{ type: "text", text: "Direct." }] }],
        reasoningEffort: "endpoint-specific",
    }).result();
    const unknownRequest = await requests[3]?.json() as Record<string, unknown>;
    expect(unknownRequest.thinking).toBeUndefined();
    expect(unknownRequest.output_config).toBeUndefined();
});

test("Anthropic thinking stays off unless the endpoint opts into adaptive mode", async () => {
    let request: Request | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "legacy-anthropic",
        model: "claude-test",
        approval_mode: "ask",
        providers: {
            "legacy-anthropic": {
                protocol: "anthropic-messages",
                base_url: "https://models.example.com/v1",
                credential: "none",
            },
        },
    }, {
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            return anthropicStream([
                { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 1 } } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
            ]);
        },
    });

    await adapter.stream({
        model: "claude-test",
        messages: [{ role: "user", content: [{ type: "text", text: "Hello." }] }],
        reasoningEffort: "medium",
    }).result();
    const body = await request?.json() as Record<string, unknown>;
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
});

test("three tool results from one turn go out as one user message", async () => {
    const body = await sentBody([
        userText("Check the three charts."),
        toolTurn(["chart-1", "chart-2", "chart-3"]),
        toolResult("chart-1", "north"),
        toolResult("chart-2", "south"),
        toolResult("chart-3", "east"),
        assistantText("All three are dry."),
        userText("Now fly to the first one."),
    ]);

    expect(body.messages.map((message) => message.role))
        .toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(body.messages[2]).toEqual({
        role: "user",
        content: [
            { type: "tool_result", tool_use_id: "chart-1", content: "north" },
            { type: "tool_result", tool_use_id: "chart-2", content: "south" },
            { type: "tool_result", tool_use_id: "chart-3", content: "east" },
        ],
    });
    expect(body.messages[4]).toEqual({ role: "user", content: "Now fly to the first one." });
});

test("user text right after the tool results follows them in the same message", async () => {
    const body = await sentBody([
        userText("Check the charts."),
        toolTurn(["chart-1", "chart-2"]),
        toolResult("chart-1", "north"),
        toolResult("chart-2", "south"),
        userText("Skip the rest."),
    ]);

    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(body.messages[2]).toEqual({
        role: "user",
        content: [
            { type: "tool_result", tool_use_id: "chart-1", content: "north" },
            { type: "tool_result", tool_use_id: "chart-2", content: "south" },
            { type: "text", text: "Skip the rest." },
        ],
    });
});

test("tool results from separate assistant turns stay in separate user messages", async () => {
    const body = await sentBody([
        userText("Check the charts."),
        toolTurn(["chart-1"]),
        toolResult("chart-1", "north"),
        toolTurn(["chart-2"]),
        toolResult("chart-2", "south"),
    ]);

    expect(body.messages.map((message) => message.role))
        .toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(body.messages[2]?.content).toEqual([
        { type: "tool_result", tool_use_id: "chart-1", content: "north" },
    ]);
    expect(body.messages[4]?.content).toEqual([
        { type: "tool_result", tool_use_id: "chart-2", content: "south" },
    ]);
});

interface SentMessage {
    readonly role: string;
    readonly content: unknown;
}

// Prompt caching is off so the bodies compare without cache markers.
async function sentBody(
    messages: readonly ModelInputMessage[],
): Promise<{ readonly messages: SentMessage[] }> {
    let request: Request | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "crow-messages",
        model: "crow-model",
        approval_mode: "ask",
        providers: {
            "crow-messages": {
                protocol: "anthropic-messages",
                base_url: "https://models.example.com/v1",
                credential: "none",
                cache: { mode: "none", usage: [] },
            },
        },
    }, {
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            return anthropicStream([
                { type: "message_start", message: { model: "crow-model", usage: { input_tokens: 1 } } },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
            ]);
        },
    });

    const result = await adapter.stream({
        model: "crow-model",
        systemPrompt: "You are a pirate crow.",
        messages,
    }).result();
    expect(result.errorMessage).toBeUndefined();
    return await request!.json() as { messages: SentMessage[] };
}

const noUsage: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
};

function userText(text: string): ModelInputMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function toolTurn(ids: readonly string[]): AssistantMessage {
    return {
        role: "assistant",
        content: ids.map((id) => ({
            type: "tool_call" as const,
            id,
            name: "read_chart",
            input: { path: `${id}.txt` },
        })),
        source: { provider: "crow-messages", api: "anthropic-messages", model: "crow-model" },
        usage: noUsage,
        stopReason: "tool_use",
    };
}

function assistantText(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "crow-messages", api: "anthropic-messages", model: "crow-model" },
        usage: noUsage,
        stopReason: "stop",
    };
}

function toolResult(toolCallId: string, text: string): ModelInputMessage {
    return {
        role: "tool_result",
        toolCallId,
        toolName: "read_chart",
        content: [{ type: "text", text }],
        isError: false,
    };
}

function anthropicStream(events: readonly Record<string, unknown>[]): Response {
    return new Response(events.map((event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
    ).join(""), { headers: { "content-type": "text/event-stream" } });
}
