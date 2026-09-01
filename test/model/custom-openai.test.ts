import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";

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
        provider: "vera-strata",
        model: "strata",
        approval_mode: "ask",
        providers: {
            "vera-strata": {
                protocol: "openai-chat",
                base_url: "https://strata.example.com/v1",
                credential: "api_key",
                api_key_env: "VERA_STRATA_API_KEY",
            },
        },
    }, {
        env: { VERA_STRATA_API_KEY: "strata-secret" },
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            return new Response([
                'data: {"model":"strata","choices":[{"index":0,"delta":{"reasoning_content":"[graph] complete\\n"},"finish_reason":null}]}',
                "",
                'data: {"model":"strata","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
                "",
                "data: [DONE]",
                "",
            ].join("\n"));
        },
    });

    const result = await adapter.stream({
        model: "strata",
        reasoningEffort: "high",
        messages: [{
            role: "user",
            content: [{ type: "text", text: "Audit this." }],
        }],
    }).result();

    expect(request?.url).toBe("https://strata.example.com/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer strata-secret");
    expect(await request?.json()).toMatchObject({
        model: "strata",
        stream: true,
        reasoning_effort: "high",
    });
    expect(result).toMatchObject({
        content: [
            { type: "thinking", text: "[graph] complete\n" },
            { type: "text", text: "Answer" },
        ],
        source: {
            provider: "vera-strata",
            api: "openai-chat-completions",
            model: "strata",
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
