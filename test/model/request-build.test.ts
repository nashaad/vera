import { expect, test } from "bun:test";

import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { emptyUsage, type ModelAdapter, type ModelRequest } from "../../src/model/types.ts";
import { createCerebrasAdapter } from "../../src/providers/cerebras-openai.ts";
import { createCustomAnthropicAdapter } from "../../src/providers/custom-anthropic.ts";
import { createCustomOpenAIAdapter } from "../../src/providers/custom-openai.ts";
import { createDeepSeekAdapter } from "../../src/providers/deepseek-openai.ts";
import { createOllamaAdapter } from "../../src/providers/ollama-openai.ts";
import { createOpenAICodexAdapter, OpenAICodexAdapter } from "../../src/providers/openai-codex.ts";
import { createOpenRouterAdapter } from "../../src/providers/openrouter.ts";
import { buildModelRequest } from "../../src/model/request-build.ts";

function duplicateRequest(): ModelRequest {
    const toolCall = {
        role: "assistant" as const,
        content: [{
            type: "tool_call" as const,
            id: "call_bash_1",
            name: "bash",
            input: { command: "echo ahoy" },
        }],
        source: { provider: "stub", api: "chat", model: "crow" },
        usage: emptyUsage(),
        stopReason: "tool_use" as const,
    };
    const result = {
        role: "tool_result" as const,
        toolCallId: "call_bash_1",
        toolName: "bash",
        content: [{ type: "text" as const, text: "ahoy" }],
        isError: false,
    };
    return { model: "crow", messages: [toolCall, result, toolCall, result] };
}

async function failureFrom(adapter: ModelAdapter, request: ModelRequest): Promise<ProviderFailureError> {
    const events = [];
    for await (const event of adapter.stream(request)) events.push(event);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type !== "error" || !(terminal.error instanceof ProviderFailureError)) {
        throw new Error("expected a classified terminal failure");
    }
    return terminal.error;
}

test("duplicate provider tool ids fail locally for every adapter without changing history", async () => {
    let sent = 0;
    const fetchStub = async () => {
        sent += 1;
        throw new Error("unexpected request");
    };
    const adapters: ModelAdapter[] = [
        createCustomOpenAIAdapter({ provider: "stub", baseUrl: "http://stub.invalid/v1", fetch: fetchStub }),
        createCustomAnthropicAdapter({ provider: "stub", baseUrl: "http://stub.invalid/v1", fetch: fetchStub }),
        createCerebrasAdapter({ apiKey: "stub", fetch: fetchStub }),
        createDeepSeekAdapter({ apiKey: "stub", fetch: fetchStub }),
        createOllamaAdapter({ host: "http://stub.invalid", fetch: fetchStub }),
        createOpenRouterAdapter({ apiKey: "stub", fetch: fetchStub }),
        new OpenAICodexAdapter(async () => {
            sent += 1;
            throw new Error("unexpected request");
        }),
    ];
    const request = duplicateRequest();
    const before = structuredClone(request);
    for (const adapter of adapters) {
        const error = await failureFrom(adapter, request);
        expect(error.failure).toMatchObject({
            kind: "request_build",
            resolution: "none",
            message: "Tool call ID normalization produced duplicate ID: call_bash_1",
        });
    }
    expect(request).toEqual(before);
    expect(sent).toBe(0);
});

test("provider-specific body serialization failures are classified before chat dispatch", async () => {
    let chatRequests = 0;
    const fetchStub = async (input: string | URL | Request) => {
        if (String(input).endsWith("/api/show")) return Response.json({ capabilities: [] });
        chatRequests += 1;
        throw new Error("unexpected request");
    };
    const adapters: ModelAdapter[] = [
        createCustomOpenAIAdapter({ provider: "stub", baseUrl: "http://stub.invalid/v1", fetch: fetchStub }),
        createCustomAnthropicAdapter({ provider: "stub", baseUrl: "http://stub.invalid/v1", fetch: fetchStub }),
        createCerebrasAdapter({ apiKey: "stub", fetch: fetchStub }),
        createDeepSeekAdapter({ apiKey: "stub", fetch: fetchStub }),
        createOllamaAdapter({ host: "http://stub.invalid", fetch: fetchStub }),
    ];
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    schema.self = schema;
    for (const adapter of adapters) {
        const error = await failureFrom(adapter, {
            model: "crow",
            messages: [],
            tools: [{ name: "read", description: "Read the nest.", inputSchema: schema }],
        });
        expect(error.failure).toMatchObject({ kind: "request_build", resolution: "none" });
        expect(error.cause).toBeInstanceOf(TypeError);
    }
    expect(chatRequests).toBe(0);
});

test("image snapshot failures produce a terminal classified stream", async () => {
    let sent = 0;
    const adapter = new OpenAICodexAdapter(async () => {
        sent += 1;
        throw new Error("unexpected request");
    });
    const error = await failureFrom(adapter, {
        model: "crow",
        messages: [{
            role: "user",
            content: [{ type: "image_attachment", attachmentId: "missing" }],
        }],
    });
    expect(error.failure).toEqual({
        kind: "request_build",
        resolution: "none",
        message: "Image attachment was not hydrated",
    });
    expect(sent).toBe(0);
});

test("responses body serialization fails before dispatch", async () => {
    let sent = 0;
    const adapter = createOpenAICodexAdapter({
        authStorage: {
            getCredential: () => ({
                type: "oauth",
                token: JSON.stringify({
                    schema_version: 1,
                    access_token: "stub",
                    refresh_token: "stub",
                    expires_at: 60_000,
                }),
            }),
            setCredential() {},
            deleteCredential() {},
        },
        now: () => 0,
        fetch: (async () => { sent += 1; throw new Error("unexpected request"); }) as unknown as typeof fetch,
    });
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    schema.self = schema;
    const error = await failureFrom(adapter, {
        model: "crow",
        messages: [],
        tools: [{ name: "read", description: "Read the nest.", inputSchema: schema }],
    });
    expect(error.failure).toMatchObject({ kind: "request_build", resolution: "none" });
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(sent).toBe(0);
});

test("SDK request validation fails before dispatch", async () => {
    let sent = 0;
    const adapter = createOpenRouterAdapter({
        apiKey: "stub",
        fetch: async () => { sent += 1; throw new Error("unexpected request"); },
    });
    const error = await failureFrom(adapter, { model: "crow", messages: [], maxTokens: NaN });
    expect(error.failure).toMatchObject({ kind: "request_build", resolution: "none" });
    expect(sent).toBe(0);
});

test("a transport failure after construction stays a retryable connection failure", async () => {
    let sent = 0;
    const adapter = createCustomOpenAIAdapter({
        provider: "stub",
        baseUrl: "http://stub.invalid/v1",
        fetch: async () => { sent += 1; throw new TypeError("socket closed"); },
    });
    const error = await failureFrom(adapter, { model: "crow", messages: [] });
    expect(error.failure).toMatchObject({ kind: "connection", resolution: "retry" });
    expect(sent).toBe(1);
});

test("an already cancelled request stays aborted during construction", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = { ...duplicateRequest(), signal: controller.signal };
    const adapters: ModelAdapter[] = [
        createCustomOpenAIAdapter({
            provider: "stub",
            baseUrl: "http://stub.invalid/v1",
            fetch: async () => { throw new Error("unexpected request"); },
        }),
        new OpenAICodexAdapter(async () => { throw new Error("unexpected request"); }),
    ];
    for (const adapter of adapters) {
        const events = [];
        for await (const event of adapter.stream(request)) events.push(event);
        const terminal = events.at(-1);
        expect(terminal?.type).toBe("error");
        expect(terminal?.type === "error" && terminal.message.stopReason).toBe("aborted");
    }
});

test("empty build errors retain a useful diagnostic", () => {
    expect(() => buildModelRequest(() => { throw new Error(""); }))
        .toThrow("Request build failed");
});
