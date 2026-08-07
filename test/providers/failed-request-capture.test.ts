import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatStreamChunk, ChatStreamDelta } from "@openrouter/sdk/models";

import {
    createFailedRequestCapture,
    redactSecrets,
    REDACTED,
} from "../../src/providers/failed-request-capture.ts";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "vera-capture-"));
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

describe("failed request capture", () => {
    test("writes the request and the raw response when the provider fails", async () => {
        const capture = createFailedRequestCapture({
            sessionId: "session-1",
            directory,
        });
        const adapter = new OpenRouterAdapter(
            async () => {
                throw new Error("Provider returned error");
            },
            undefined,
            undefined,
            capture,
        );

        const message = await adapter.stream({
            model: "test/model",
            systemPrompt: "Be concise.",
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        }).result();

        const path = join(directory, "session-1-1.json");
        const written = JSON.parse(readFileSync(path, "utf8")) as {
            outcome: string;
            session_id: string;
            request: { model: string; messages: unknown };
            failure: { kind: string };
        };
        expect(written.outcome).toBe("provider_error");
        expect(written.session_id).toBe("session-1");
        expect(written.request.model).toBe("test/model");
        expect(written.request.messages).toEqual([
            { role: "system", content: "Be concise." },
            { role: "user", content: "hello" },
        ]);
        expect(written.failure.kind).toBeString();
        // The path is how a person finds the file from the turn alone.
        expect(message.errorMessage).toContain(path);
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    test("keeps the chunks a stream sent before it failed", async () => {
        const capture = createFailedRequestCapture({
            sessionId: "session-chunks",
            directory,
        });
        const adapter = new OpenRouterAdapter(
            async () => failingStream(),
            undefined,
            undefined,
            capture,
        );

        await adapter.stream({
            model: "test/model",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }).result();

        const written = JSON.parse(
            readFileSync(join(directory, "session-chunks-1.json"), "utf8"),
        ) as { response: readonly { choices: readonly { delta: ChatStreamDelta }[] }[] };
        expect(written.response).toHaveLength(1);
        expect(written.response[0]?.choices[0]?.delta.content).toBe("partial");
    });

    test("captures a turn that returned no visible content", async () => {
        const capture = createFailedRequestCapture({
            sessionId: "session-empty",
            directory,
        });
        const adapter = new OpenRouterAdapter(
            async () => chunks([
                chunk({ delta: { reasoning: "thinking about it" } }),
                chunk({ delta: {}, finishReason: "stop" }),
            ]),
            undefined,
            undefined,
            capture,
        );

        const message = await adapter.stream({
            model: "test/model",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }).result();

        const written = JSON.parse(
            readFileSync(join(directory, "session-empty-1.json"), "utf8"),
        ) as { outcome: string };
        expect(written.outcome).toBe("empty_response");
        // The turn's own outcome is unchanged by having been captured.
        expect(message.stopReason).toBe("stop");
    });

    test("writes nothing when the turn succeeds", async () => {
        const capture = createFailedRequestCapture({
            sessionId: "session-ok",
            directory,
        });
        const adapter = new OpenRouterAdapter(
            async () => chunks([
                chunk({ delta: { content: "answer" }, finishReason: "stop" }),
            ]),
            undefined,
            undefined,
            capture,
        );

        const message = await adapter.stream({
            model: "test/model",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }).result();

        expect(message.stopReason).toBe("stop");
        expect(readdirSync(directory)).toEqual([]);
    });

    test("stops after the per-session cap", () => {
        const capture = createFailedRequestCapture({
            sessionId: "session-cap",
            directory,
            maxCaptures: 2,
        });
        const detail = {
            provider: "openrouter",
            api: "openrouter-chat",
            model: "test/model",
            outcome: "provider_error" as const,
            request: { model: "test/model" },
            response: [],
        };

        expect(capture(detail)).toBe(join(directory, "session-cap-1.json"));
        expect(capture(detail)).toBe(join(directory, "session-cap-2.json"));
        expect(capture(detail)).toBeUndefined();
        expect(readdirSync(directory)).toHaveLength(2);
    });

    test("stays under the byte cap and stays parseable", () => {
        const capture = createFailedRequestCapture({
            sessionId: "session-bytes",
            directory,
            maxBytes: 4_096,
        });

        const path = capture({
            provider: "openrouter",
            api: "openrouter-chat",
            model: "test/model",
            outcome: "provider_error",
            request: { model: "test/model", messages: ["x".repeat(200_000)] },
            response: ["y".repeat(200_000)],
        });

        expect(path).toBeString();
        const source = readFileSync(path as string, "utf8");
        expect(Buffer.byteLength(source, "utf8")).toBeLessThanOrEqual(4_096);
        const written = JSON.parse(source) as { omitted: string; response: unknown[] };
        expect(written.response).toEqual([]);
        expect(written.omitted).toBeString();
    });

    test("redacts credentials without touching message content", () => {
        const redacted = redactSecrets({
            headers: {
                authorization: "Bearer sk-or-v1-abcdef0123456789",
                "x-api-key": "sk-or-v1-abcdef0123456789",
                "content-type": "application/json",
            },
            maxTokens: 8_000,
            error: "401 for Authorization: Bearer sk-or-v1-abcdef0123456789",
            messages: [{ role: "user", content: "explain my token budget" }],
        }) as {
            headers: Record<string, string>;
            maxTokens: number;
            error: string;
            messages: readonly { content: string }[];
        };

        expect(redacted.headers.authorization).toBe(REDACTED);
        expect(redacted.headers["x-api-key"]).toBe(REDACTED);
        expect(redacted.headers["content-type"]).toBe("application/json");
        // A field whose name merely reads like a secret is left alone.
        expect(redacted.maxTokens).toBe(8_000);
        expect(redacted.error).not.toContain("sk-or-v1-abcdef0123456789");
        expect(redacted.messages[0]?.content).toBe("explain my token budget");
    });

    test("redacts a credential reaching the file through the request body", async () => {
        const capture = createFailedRequestCapture({
            sessionId: "session-secret",
            directory,
        });
        const adapter = new OpenRouterAdapter(
            async () => {
                const error = new Error(
                    "HTTP 401 with authorization: Bearer sk-or-v1-0123456789abcdef",
                );
                throw error;
            },
            undefined,
            undefined,
            capture,
        );

        await adapter.stream({
            model: "test/model",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }).result();

        const source = readFileSync(
            join(directory, "session-secret-1.json"),
            "utf8",
        );
        expect(source).not.toContain("sk-or-v1-0123456789abcdef");
        expect(source).toContain(REDACTED);
    });

    test("writes nothing when no capture sink is wired in", async () => {
        const adapter = new OpenRouterAdapter(async () => {
            throw new Error("Provider returned error");
        });

        const message = await adapter.stream({
            model: "test/model",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }).result();

        expect(message.errorMessage).not.toContain("request captured at");
        expect(readdirSync(directory)).toEqual([]);
    });
});

interface ChunkOptions {
    readonly delta: ChatStreamDelta;
    readonly finishReason?: "stop" | "tool_calls";
}

function chunk(options: ChunkOptions): ChatStreamChunk {
    return {
        id: "chunk_test",
        created: 0,
        model: "test/model",
        object: "chat.completion.chunk",
        choices: [
            {
                index: 0,
                delta: options.delta,
                finishReason: options.finishReason ?? null,
            },
        ],
    };
}

async function* chunks(
    values: readonly ChatStreamChunk[],
): AsyncIterable<ChatStreamChunk> {
    for (const value of values) {
        yield value;
    }
}

async function* failingStream(): AsyncIterable<ChatStreamChunk> {
    yield chunk({ delta: { content: "partial" } });
    throw new Error("stream disconnected");
}
