import { expect, test } from "bun:test";

import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import type { AssistantMessage } from "../../src/model/types.ts";

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
        system: "Be precise.",
        model: "claude-test",
        stream: true,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        tools: [{ name: "read_file" }],
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

function anthropicStream(events: readonly Record<string, unknown>[]): Response {
    return new Response(events.map((event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
    ).join(""), { headers: { "content-type": "text/event-stream" } });
}
