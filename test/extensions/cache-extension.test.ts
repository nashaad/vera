import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheMissText } from "../../extensions/cache/cache-text.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter, type ModelRequest, type ModelStreamEvent } from "../../src/model/types.ts";
import type { ModelNotice } from "../../src/sdk/model-middleware.ts";

const path = new URL("../../extensions/cache", import.meta.url).pathname;

function turnMessage(inputTokens: number, cachedInputTokens: number, model = "deepseek-flash"): AssistantMessage {
    return { role: "assistant", content: [{ type: "text", text: "ok" }],
        source: { provider: "deepseek", api: "fixture", model },
        usage: { ...emptyUsage(), inputTokens, cachedInputTokens }, stopReason: "stop" };
}

function scripted(message: AssistantMessage): ModelAdapter {
    return {
        stream(): ModelEventStream {
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            stream.push({ type: "done", message });
            return stream;
        },
    };
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
    const events: ModelStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

const request: ModelRequest = { model: "fixture", messages: [] };

test("@core middleware passes events through and notifies once after the broken pattern", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cache-extension-"));
    const registry = await startExtensionRegistry({ extensions: [{ path, enabled: true, config: {} }] });
    try {
        const notices: ModelNotice[] = [];
        const context = (purpose: "turn" | "ask" = "turn") => ({
            sessionId: "s", sessionPath: join(directory, "s.jsonl"), workspace: directory, provider: "deepseek",
            purpose, notice: (notice: string | ModelNotice) => {
                if (typeof notice !== "string") notices.push(notice);
            },
        });
        const middleware = registry.modelMiddleware()[0]!;
        expect(middleware.extensionId).toBe("vera.cache");
        const base = scripted(turnMessage(150_000, 0));
        expect(middleware.apply(base, context("ask"))).toBe(base);

        for (let index = 0; index < 30; index++) {
            const wrapped = middleware.apply(scripted(turnMessage(150_000, 105_000)), context());
            const events = await collect(wrapped.stream(request));
            expect(events.map((event) => event.type)).toEqual(["start", "done"]);
        }
        expect(notices).toEqual([{ key: "cache_miss", facts: {
            calls: 20,
            reread_tokens: 900_000,
            input_tokens: 3_000_000,
            provider: "deepseek",
            model: "deepseek-flash",
        } }]);
    } finally {
        await registry.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a notice that throws does not break the stream", async () => {
    const registry = await startExtensionRegistry({ extensions: [{ path, enabled: true, config: {} }] });
    try {
        const middleware = registry.modelMiddleware()[0]!;
        const context = {
            sessionId: "throwing", sessionPath: "", workspace: "", provider: "deepseek", purpose: "turn" as const,
            notice: () => { throw new Error("notice failed"); },
        };
        for (let index = 0; index < 25; index++) {
            const wrapped = middleware.apply(scripted(turnMessage(150_000, 105_000)), context);
            const events = await collect(wrapped.stream(request));
            expect(events.map((event) => event.type)).toEqual(["start", "done"]);
        }
    } finally {
        await registry.close();
    }
});

test("a warning turned off registers no middleware", async () => {
    const registry = await startExtensionRegistry({ extensions: [{ path, enabled: true, config: { min_tokens: 0 } }] });
    try {
        expect(registry.modelMiddleware()).toEqual([]);
    } finally {
        await registry.close();
    }
});

test("@core cacheMissText words the notice", () => {
    expect(cacheMissText({ key: "cache_miss", facts: {
        calls: 20, reread_tokens: 1_400_000, input_tokens: 4_516_129, provider: "deepseek", model: "deepseek-flash",
    } })).toBe("Prompt cache keeps missing: the last 20 calls to deepseek-flash re-read 1.4m tokens it had already cached (31% of their input).");
});

test("cacheMissText ignores other keys, missing facts and zero input", () => {
    const facts = { calls: 20, reread_tokens: 1_400_000, input_tokens: 4_516_129, provider: "deepseek", model: "deepseek-flash" };
    expect(cacheMissText({ key: "other", facts })).toBeUndefined();
    expect(cacheMissText({ key: "cache_miss", facts: { ...facts, calls: undefined as unknown as number } })).toBeUndefined();
    expect(cacheMissText({ key: "cache_miss", facts: { ...facts, reread_tokens: "1" } })).toBeUndefined();
    expect(cacheMissText({ key: "cache_miss", facts: { ...facts, input_tokens: 0 } })).toBeUndefined();
    expect(cacheMissText({ key: "cache_miss", facts: { ...facts, model: "" } })).toBeUndefined();
});
