import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { createCustomOpenAIAdapter } from "../../src/providers/custom-openai.ts";
import { writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";

function withIsolatedHome<T>(run: () => T): T {
    const home = mkdtempSync(join(tmpdir(), "vera-custom-openai-"));
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        return run();
    } finally {
        if (previous === undefined) {
            delete process.env.VERA_HOME;
        } else {
            process.env.VERA_HOME = previous;
        }
        rmSync(home, { recursive: true, force: true });
    }
}

test("a named OpenAI endpoint streams reasoning and text", async () => {
    let request: Request | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "vera-sample",
        model: "sample",
        approval_mode: "ask",
        providers: {
            "vera-sample": {
                protocol: "openai-chat",
                base_url: "https://sample.example.com/v1",
                credential: "api_key",
                api_key_env: "VERA_SAMPLE_API_KEY",
            },
        },
    }, {
        env: { VERA_SAMPLE_API_KEY: "sample-secret" },
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            return new Response([
                'data: {"model":"sample","choices":[{"index":0,"delta":{"reasoning_content":"[graph] complete\\n"},"finish_reason":null}]}',
                "",
                'data: {"model":"sample","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
                "",
                "data: [DONE]",
                "",
            ].join("\n"));
        },
    });

    const result = await adapter.stream({
        model: "sample",
        reasoningEffort: "high",
        messages: [{
            role: "user",
            content: [{ type: "text", text: "Audit this." }],
        }],
    }).result();

    expect(request?.url).toBe("https://sample.example.com/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer sample-secret");
    const body = await request!.json() as Record<string, unknown>;
    expect(body).toMatchObject({
        model: "sample",
        stream: true,
    });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(result).toMatchObject({
        content: [
            { type: "thinking", text: "[graph] complete\n" },
            { type: "text", text: "Answer" },
        ],
        source: {
            provider: "vera-sample",
            api: "openai-chat-completions",
            model: "sample",
        },
        stopReason: "stop",
    });
});

test("a named endpoint may deliberately require no credential", async () => {
    let authorization: string | null | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "local-gateway",
        model: "model",
        approval_mode: "ask",
        providers: {
            "local-gateway": {
                protocol: "openai-chat",
                base_url: "http://127.0.0.1:8790/v1",
                credential: "none",
            },
        },
    }, {
        authStorage: {
            getCredential: () => ({
                type: "api_key" as const,
                key: "stale-secret-that-must-not-leave",
            }),
            setCredential: () => {},
            deleteCredential: () => {},
        },
        fetch: async (_input, init) => {
            authorization = new Headers(init?.headers).get("authorization");
            return new Response(
                'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            );
        },
    });

    expect((await adapter.stream({ model: "model", messages: [] }).result())
        .stopReason).toBe("stop");
    expect(authorization).toBeNull();
});

test("the built-in oMLX provider uses its local OpenAI endpoint", async () => {
    let request: Request | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "omlx",
        model: "Qwen3-Coder-Next-8bit",
        approval_mode: "ask",
    }, {
        authStorage: {
            getCredential: () => ({
                type: "api_key" as const,
                key: "stored-omlx-secret",
            }),
            setCredential: () => {},
            deleteCredential: () => {},
        },
        env: { OMLX_API_KEY: "env-omlx-secret" },
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            return new Response(
                'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            );
        },
    });

    expect((await adapter.stream({
        model: "Qwen3-Coder-Next-8bit",
        messages: [],
    }).result()).stopReason).toBe("stop");
    expect(request?.url).toBe(
        "http://127.0.0.1:8000/v1/chat/completions",
    );
    expect(request?.headers.get("authorization")).toBe(
        "Bearer stored-omlx-secret",
    );
});

test("an omitted custom images declaration stays unknown", () => {
    withIsolatedHome(() => {
        const adapter = createConfiguredModelAdapter({
            schema_version: 1,
            provider: "unsloth-local",
            model: "qwen",
            approval_mode: "ask",
            providers: {
                "unsloth-local": {
                    protocol: "openai-chat",
                    base_url: "http://127.0.0.1:8888/v1",
                    credential: "none",
                },
            },
        }, {
            fetch: async () => new Response(
                'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            ),
        });
        expect(adapter.supportsImageInput).toBeUndefined();
        expect(adapter.imageInputSupport?.("qwen")).toBeUndefined();
    });
});

test("an explicit custom images declaration is the adapter's blanket answer", () => {
    const blocked = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "unsloth-local",
        model: "qwen",
        approval_mode: "ask",
        providers: {
            "unsloth-local": {
                protocol: "openai-chat",
                base_url: "http://127.0.0.1:8888/v1",
                credential: "none",
                images: false,
            },
        },
    }, {
        fetch: async () => new Response(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        ),
    });
    expect(blocked.supportsImageInput).toBe(false);

    const allowed = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "unsloth-local",
        model: "qwen",
        approval_mode: "ask",
        providers: {
            "unsloth-local": {
                protocol: "openai-chat",
                base_url: "http://127.0.0.1:8888/v1",
                credential: "none",
                images: true,
            },
        },
    }, {
        fetch: async () => new Response(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        ),
    });
    expect(allowed.supportsImageInput).toBe(true);
});

function sseOk(): Response {
    return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    );
}

test("Unsloth Qwen overlay sends enable_thinking kwargs, not reasoning_effort", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "unsloth-local",
        model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
        approval_mode: "ask",
        providers: {
            "unsloth-local": {
                protocol: "openai-chat",
                base_url: "http://127.0.0.1:8888/v1",
                credential: "none",
            },
        },
    }, {
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return sseOk();
        },
    });

    await adapter.stream({
        model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
        reasoningEffort: "off",
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    }).result();

    expect(body).toMatchObject({
        chat_template_kwargs: { enable_thinking: false },
    });
    expect(body).not.toHaveProperty("reasoning_effort");

    await adapter.stream({
        model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
        reasoningEffort: "high",
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    }).result();
    expect(body).toMatchObject({
        chat_template_kwargs: { enable_thinking: true },
    });
    expect(body).not.toHaveProperty("reasoning_effort");
});

test("gpt-oss on the same custom URL sends reasoning_effort and not kwargs", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "unsloth-local",
        model: "gpt-oss:20b",
        approval_mode: "ask",
        providers: {
            "unsloth-local": {
                protocol: "openai-chat",
                base_url: "http://127.0.0.1:8888/v1",
                credential: "none",
            },
        },
    }, {
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return sseOk();
        },
    });

    await adapter.stream({
        model: "gpt-oss:20b",
        reasoningEffort: "medium",
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    }).result();

    expect(body).toMatchObject({ reasoning_effort: "medium" });
    expect(body).not.toHaveProperty("chat_template_kwargs");
});

test("catalog levels on an unmatched custom model still send reasoning_effort", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-custom-catalog-"));
    const cacheDir = join(directory, "cache");
    try {
        writeProviderCatalogSnapshot({
            schema_version: 2,
            provider: "local-gateway",
            models: [{
                id: "mystery-reasoner",
                label: "Mystery",
                levels: [
                    { id: "high", label: "High" },
                    { id: "medium", label: "Medium" },
                    { id: "low", label: "Low" },
                ],
            }],
        }, { cacheDir });

        let body: Record<string, unknown> | undefined;
        const adapter = createCustomOpenAIAdapter({
            provider: "local-gateway",
            baseUrl: "http://127.0.0.1:8888/v1",
            cacheDir,
            fetch: async (_input, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                return sseOk();
            },
        });

        await adapter.stream({
            model: "mystery-reasoner",
            reasoningEffort: "medium",
            messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        }).result();

        expect(body).toMatchObject({ reasoning_effort: "medium" });
        expect(body).not.toHaveProperty("chat_template_kwargs");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
