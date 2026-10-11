import { describe, expect, test } from "bun:test";

import type { VeraConfig } from "../../src/config.ts";
import type {
    ProviderCacheMode,
    ProviderDeclaration,
} from "../../src/providers/definitions.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { createCustomOpenAIAdapter } from "../../src/providers/custom-openai.ts";
import { configuredProviders, type ProviderDescriptor } from "../../src/providers/registry.ts";
import type { CacheRetention } from "../../src/model/prompt-cache.ts";
import type {
    AssistantMessage,
    ModelInputMessage,
    ModelRequest,
    ModelUsage,
} from "../../src/model/types.ts";

// Each shipped provider, one declared provider per protocol, and one declared with its own cache
// block must honor the cache block it ends up with. The fake server below only reuses a prefix the
// way that mode allows, so an adapter that drops the key, the breakpoints, or a stable prefix gets
// no hits and fails here.

type Wire = "openai-chat" | "openrouter" | "anthropic" | "codex";

interface Row {
    readonly provider: ProviderDescriptor;
    readonly model: string;
    readonly wire: Wire;
    // How the upstream behind this model caches, when it differs from the provider's own block.
    readonly serverMode?: ProviderCacheMode;
}

const DECLARED: Readonly<Record<string, ProviderDeclaration>> = {
    "crow-chat": {
        protocol: "openai-chat",
        base_url: "https://crow-chat.example/v1",
        credential: "api_key",
        api_key_env: "CROW_CHAT_KEY",
    },
    "crow-messages": {
        protocol: "anthropic-messages",
        base_url: "https://crow-messages.example/v1",
        credential: "api_key",
        api_key_env: "CROW_MESSAGES_KEY",
    },
    "crow-keyed": {
        protocol: "openai-chat",
        base_url: "https://crow-keyed.example/v1",
        credential: "api_key",
        api_key_env: "CROW_KEYED_KEY",
        cache: { mode: "key", usage: ["read", "write"], affinity_header: "X-Crow-Affinity" },
    },
};

const providers = configuredProviders({ providers: DECLARED });
const rows: readonly Row[] = providers.flatMap((provider): Row[] => {
    const wire: Wire = provider.behaviorId === "openai-codex" ? "codex"
        : provider.behaviorId === "openrouter" ? "openrouter"
        : provider.protocol === "anthropic-messages" ? "anthropic"
        : "openai-chat";
    const row = { provider, model: "crow-model", wire };
    return wire === "openrouter"
        ? [row, { ...row, model: "anthropic/crow-model", serverMode: "breakpoints" }]
        : [row];
});

describe("every provider honors its declared prompt cache", () => {
    test("the table covers every shipped and declared provider", () => {
        expect(new Set(rows.map((row) => row.provider.id))).toEqual(
            new Set(providers.map((provider) => provider.id)),
        );
    });

    for (const row of rows) {
        const cache = row.provider.cache!;
        test(`${row.provider.id} ${row.model}: ${cache.mode}, reports ${cache.usage.join("+") || "nothing"}`, async () => {
            const server = new PrefixCacheServer(row.wire, row.serverMode ?? cache.mode);
            const adapter = adapterFor(row, server);

            const first = await adapter.stream(request(row.model, firstTurn())).result();
            const second = await adapter.stream(request(row.model, secondTurn(first))).result();
            expect(first.errorMessage).toBeUndefined();
            expect(second.errorMessage).toBeUndefined();

            const [firstHit, secondHit] = server.hits;
            if (cache.affinity_header !== undefined) {
                expect(server.headers[0]?.get(cache.affinity_header)).toBe("crow-session-7");
            }
            if (cache.mode === "none") {
                expect(server.sentAnyCacheHint(cache.affinity_header)).toBe(false);
            } else {
                // The whole first request is the second one's prefix, so all of it is reused.
                expect(secondHit!.read).toBe(firstHit!.input);
            }
            if (cache.usage.includes("read")) {
                expect(usageOf(second)).toMatchObject({
                    inputTokens: secondHit!.input,
                    cachedInputTokens: secondHit!.read,
                });
            }
            if (cache.usage.includes("write")) {
                expect(usageOf(first).cacheWriteInputTokens).toBe(firstHit!.write);
                expect(firstHit!.write).toBeGreaterThan(0);
            }
        });

        test(`${row.provider.id} ${row.model}: retention none sends no key and no breakpoints`, async () => {
            const server = new PrefixCacheServer(row.wire, row.serverMode ?? cache.mode);
            const adapter = adapterFor(row, server);

            await adapter.stream(request(row.model, firstTurn(), "none")).result();
            expect(server.sentAnyCacheHint(cache.affinity_header)).toBe(false);
        });
    }

    test("long retention asks for the one-hour breakpoints", async () => {
        for (const row of rows.filter((entry) => (entry.serverMode ?? entry.provider.cache!.mode) === "breakpoints")) {
            const server = new PrefixCacheServer(row.wire, "breakpoints");
            const adapter = adapterFor(row, server);

            await adapter.stream(request(row.model, firstTurn(), "long")).result();
            expect(server.markers.length).toBeGreaterThan(0);
            for (const marker of server.markers) {
                expect(marker).toEqual({ type: "ephemeral", ttl: "1h" });
            }
        }
    });

    test("breakpoints keep the system prompt and tools cached when the history is rewritten", async () => {
        const marked = rows.filter((entry) => (entry.serverMode ?? entry.provider.cache!.mode) === "breakpoints");
        expect(marked.length).toBeGreaterThan(0);
        for (const row of marked) {
            const server = new PrefixCacheServer(row.wire, "breakpoints");
            const adapter = adapterFor(row, server);
            const compacted: ModelInputMessage[] = [
                { role: "user", content: [{ type: "text", text: "Summary: the crow found the map." }] },
            ];

            await adapter.stream(request(row.model, firstTurn())).result();
            await adapter.stream(request(row.model, compacted)).result();
            expect(server.hits[1]!.read).toBeGreaterThan(0);
            expect(server.hits[1]!.read).toBe(server.hits[1]!.head);
        }
    });

    test("a changed system prompt still reuses the tools on the Messages API", async () => {
        const row = rows.find((entry) => entry.wire === "anthropic")!;
        const server = new PrefixCacheServer(row.wire, "breakpoints");
        const adapter = adapterFor(row, server);

        await adapter.stream(request(row.model, firstTurn())).result();
        await adapter.stream({ ...request(row.model, firstTurn()), systemPrompt: "Fly at dawn." }).result();
        expect(server.hits[1]!.read).toBeGreaterThan(0);
    });

    test("an affinity header carries the session key to the gateway", async () => {
        const server = new PrefixCacheServer("openai-chat", "key");
        const adapter = createCustomOpenAIAdapter({
            provider: "crow-gateway",
            baseUrl: "https://crow-gateway.example/v1",
            cache: { mode: "key", usage: ["read"], affinity_header: "x-crow-affinity" },
            fetch: server.fetch,
        });

        await adapter.stream(request("crow-model", firstTurn())).result();
        expect(server.headers[0]?.get("x-crow-affinity")).toBe("crow-session-7");
        expect(server.bodies[0]?.prompt_cache_key).toBe("crow-session-7");
    });
});

function adapterFor(row: Row, server: PrefixCacheServer) {
    const env: Record<string, string> = {};
    for (const provider of providers) {
        if (provider.envVar !== undefined && provider.credential !== "none") {
            env[provider.envVar] = "crow-key";
        }
    }
    return createConfiguredModelAdapter({
        schema_version: 1,
        provider: row.provider.id,
        model: row.model,
        approval_mode: "ask",
        providers: DECLARED,
    } as VeraConfig, {
        env,
        fetch: server.fetch,
        authStorage: {
            getCredential: () => ({
                type: "oauth" as const,
                token: JSON.stringify({
                    schema_version: 1,
                    access_token: "crow-token",
                    refresh_token: "crow-refresh",
                    expires_at: Number.MAX_SAFE_INTEGER,
                }),
            }),
            setCredential() {},
            deleteCredential() {},
        },
        imageSupport: () => false,
    });
}

function request(
    model: string,
    messages: readonly ModelInputMessage[],
    cacheRetention?: CacheRetention,
): ModelRequest {
    return {
        model,
        systemPrompt: "You are a pirate crow. Keep the charts dry.\n".repeat(20),
        tools: [{
            name: "read_chart",
            description: "Read one sea chart",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
        }],
        messages,
        cacheKey: "crow-session-7",
        ...(cacheRetention === undefined ? {} : { cacheRetention }),
    };
}

function firstTurn(): ModelInputMessage[] {
    return [{ role: "user", content: [{ type: "text", text: "Where is the treasure buried?" }] }];
}

function secondTurn(first: AssistantMessage): ModelInputMessage[] {
    return [
        ...firstTurn(),
        first,
        { role: "user", content: [{ type: "text", text: "Dig there, then." }] },
    ];
}

function usageOf(message: AssistantMessage): ModelUsage {
    return message.usage;
}

interface Hit {
    readonly input: number;
    // The tools and system prompt, ahead of the conversation.
    readonly head: number;
    readonly read: number;
    readonly write: number;
}

interface Block {
    readonly text: string;
    readonly marked: boolean;
    readonly head?: boolean;
}

// Caches whole blocks. An entry is a block prefix; its size is the characters in those blocks.
class PrefixCacheServer {
    readonly hits: Hit[] = [];
    readonly bodies: Record<string, unknown>[] = [];
    readonly headers: Headers[] = [];
    readonly markers: unknown[] = [];
    private readonly entries = new Map<string, Set<string>>();

    constructor(
        private readonly wire: Wire,
        private readonly mode: ProviderCacheMode,
    ) {}

    readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
        const raw = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
        const body = JSON.parse(raw) as Record<string, unknown>;
        this.bodies.push(body);
        this.headers.push(new Headers(input instanceof Request ? input.headers : init?.headers));
        const blocks = this.blocks(body);
        const hit = this.serve(blocks, cacheKey(body));
        this.hits.push(hit);
        return this.respond(hit, typeof body.model === "string" ? body.model : "crow-model");
    };

    sentAnyCacheHint(affinityHeader?: string): boolean {
        return this.markers.length > 0
            || this.bodies.some((body) =>
                body.prompt_cache_key !== undefined || body.session_id !== undefined
            )
            || this.headers.some((headers) =>
                headers.has("session-id")
                || headers.has("x-session-id")
                || (affinityHeader !== undefined && headers.has(affinityHeader))
            );
    }

    private serve(blocks: readonly Block[], key: string | undefined): Hit {
        const input = size(blocks);
        const head = size(blocks.filter((block) => block.head === true));
        if (this.mode === "none" || (this.mode === "key" && key === undefined)) {
            return { input, head, read: 0, write: 0 };
        }
        const stored = this.entries.get(key ?? "") ?? new Set<string>();
        this.entries.set(key ?? "", stored);
        let readBlocks = 0;
        for (let end = blocks.length; end > 0; end -= 1) {
            if (stored.has(prefixId(blocks, end))) {
                readBlocks = end;
                break;
            }
        }
        const ends = this.mode === "breakpoints"
            ? blocks.flatMap((block, index) => block.marked ? [index + 1] : [])
            : [blocks.length];
        for (const end of ends) stored.add(prefixId(blocks, end));
        const lastWrite = Math.max(readBlocks, ...ends);
        return {
            input,
            head,
            read: size(blocks.slice(0, readBlocks)),
            write: size(blocks.slice(readBlocks, lastWrite)),
        };
    }

    private blocks(body: Record<string, unknown>): Block[] {
        const blocks: Block[] = [];
        const add = (value: unknown, marked: unknown = value, head = false): void => {
            const marker = isRecord(marked) ? marked.cache_control : undefined;
            if (marker !== undefined) this.markers.push(marker);
            blocks.push({ text: JSON.stringify(withoutMarkers(value)), marked: marker !== undefined, head });
        };
        for (const tool of arrayOf(body.tools)) add(tool, tool, true);
        if (this.wire === "codex") {
            add(body.instructions, undefined, true);
            for (const item of arrayOf(body.input)) add(item);
            return blocks;
        }
        if (this.wire === "anthropic") {
            if (typeof body.system === "string") add(body.system, undefined, true);
            for (const part of arrayOf(body.system)) add(part, part, true);
            for (const message of arrayOf(body.messages)) {
                if (!isRecord(message)) continue;
                const content = typeof message.content === "string"
                    ? [{ type: "text", text: message.content }]
                    : arrayOf(message.content);
                for (const part of content) add({ role: message.role, part }, part);
            }
            return blocks;
        }
        for (const message of arrayOf(body.messages)) {
            if (!isRecord(message)) continue;
            const parts = arrayOf(message.content);
            const marker = parts.find((part) => isRecord(part) && part.cache_control !== undefined);
            if (isRecord(marker)) this.markers.push(marker.cache_control);
            blocks.push({
                text: JSON.stringify(withoutMarkers(message)),
                marked: marker !== undefined,
                head: message.role === "system",
            });
        }
        if (body.cache_control !== undefined && blocks.length > 0) {
            this.markers.push(body.cache_control);
            blocks[blocks.length - 1] = { ...blocks[blocks.length - 1]!, marked: true };
        }
        return blocks;
    }

    private respond(hit: Hit, model: string): Response {
        const events = this.wire === "anthropic" ? anthropicEvents(hit, model)
            : this.wire === "codex" ? codexEvents(hit)
            : chatEvents(hit, model);
        const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
            + (this.wire === "anthropic" ? "" : "data: [DONE]\n\n");
        return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
}

function chatEvents(hit: Hit, model: string): unknown[] {
    const base = { id: "crow-1", object: "chat.completion.chunk", created: 0, model };
    return [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Under the palm." }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        {
            ...base,
            choices: [],
            usage: {
                prompt_tokens: hit.input,
                completion_tokens: 4,
                total_tokens: hit.input + 4,
                prompt_tokens_details: { cached_tokens: hit.read, cache_write_tokens: hit.write },
            },
        },
    ];
}

function anthropicEvents(hit: Hit, model: string): unknown[] {
    return [
        {
            type: "message_start",
            message: {
                model,
                usage: {
                    input_tokens: hit.input - hit.read - hit.write,
                    cache_read_input_tokens: hit.read,
                    cache_creation_input_tokens: hit.write,
                },
            },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Under the palm." } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
    ];
}

function codexEvents(hit: Hit): unknown[] {
    return [
        { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
        {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "message", content: [{ type: "output_text", text: "Under the palm." }] },
        },
        {
            type: "response.completed",
            response: {
                usage: {
                    input_tokens: hit.input,
                    input_tokens_details: { cached_tokens: hit.read },
                    output_tokens: 4,
                    total_tokens: hit.input + 4,
                },
            },
        },
    ];
}

function cacheKey(body: Record<string, unknown>): string | undefined {
    return typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined;
}

function withoutMarkers(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutMarkers);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => key !== "cache_control")
            .map(([key, inner]) => [key, withoutMarkers(inner)]),
    );
}

function prefixId(blocks: readonly Block[], end: number): string {
    return JSON.stringify(blocks.slice(0, end).map((block) => block.text));
}

function size(blocks: readonly Block[]): number {
    return blocks.reduce((total, block) => total + block.text.length, 0);
}

function arrayOf(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
