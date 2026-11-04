import { join } from "node:path";
import { assertTrialHome, hash, log, random } from "./common.ts";

interface ChatMessage {
    role: string;
    content?: unknown;
    tool_calls?: { id: string }[];
}
interface ChatRequest {
    model?: string;
    messages?: ChatMessage[];
    tools?: unknown[];
    stream?: boolean;
}
export interface FauxOptions {
    seed: number;
    logPath?: string;
    speed?: number;
}

export function startProvider(options: FauxOptions) {
    const speed = options.speed ?? 1;
    const record = (event: object) => { if (options.logPath) log(options.logPath, event); };
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0, idleTimeout: 255,
        async fetch(request) {
            if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") {
                return Response.json({ data: Array.from({ length: 20 }, (_, i) => ({ id: `crow-${i}` })) });
            }
            if (request.method !== "POST") return new Response("Not found", { status: 404 });
            const raw = await request.text();
            const body = JSON.parse(raw) as ChatRequest;
            const messages = body.messages ?? [];
            let marker: RegExpMatchArray | null = null;
            let userIndex = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i]?.role !== "user") continue;
                const found = JSON.stringify(messages[i]?.content).match(/LOAD_TURN:(crow-\d+):(\d+)/);
                if (found) { marker = found; userIndex = i; break; }
            }
            const scripted = marker !== null && (body.tools?.length ?? 0) > 0;
            const key = marker ? `${marker[1]}:${marker[2]}` : String(hash(raw));
            const turnRng = random(options.seed ^ hash(key));
            const rounds = 6 + Math.floor(turnRng() * 7);
            const round = messages.slice(userIndex + 1).filter((message) => message.role === "tool").length;
            const rng = random(options.seed ^ hash(`${key}:${round}`));
            const firstMs = 600 + rng() * 900;
            const intervalMs = 40 + rng() * 20;
            const tokensPerSecond = 40 + rng() * 40;
            const tool = scripted && round < rounds;
            const outputTokens = tool ? 36 : scripted ? 300 + Math.floor(rng() * 501) : 80;
            const inputTokens = Math.ceil(Buffer.byteLength(raw) / 4);
            const path = `sessions/${marker?.[1] ?? "crow-0000"}.txt`;
            const toolName = ["read", "edit", "grep"][round % 3]!;
            const input = toolName === "read" ? { path, limit: 1000 }
                : toolName === "edit" ? { path, edits: [{ old_string: "pirate-crow-state:", new_string: "pirate-crow-state:x" }] }
                : { path: "corpus.txt", pattern: "pirate", max_results: 400, output_mode: "content" };
            const args = JSON.stringify(input);
            const text = Array.from({ length: outputTokens }, (_, i) => [" crow", " sails", " past", " reefs"][i % 4]).join("");
            const content = tool ? args : text;
            const id = `call-${hash(key)}-${round}`;
            const usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
            record({ type: "request", key, round, rounds, scripted, tool: tool ? toolName : null, inputTokens, outputTokens, firstMs, intervalMs, tokensPerSecond });
            if (body.stream === false) {
                await Bun.sleep(firstMs / speed);
                return Response.json({ id, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
            }
            let cancelled = false;
            const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                    const encoder = new TextEncoder();
                    const send = (delta: object, finish: string | null = null, billed?: object) => {
                        if (cancelled || request.signal.aborted) return false;
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(billed ? { usage: billed } : {}) })}\n\n`));
                        return true;
                    };
                    try {
                        await Bun.sleep(firstMs / speed);
                        if (tool) send({ tool_calls: [{ index: 0, id, type: "function", function: { name: toolName, arguments: "" } }] });
                        const chunks = Math.max(1, Math.ceil(outputTokens / (tokensPerSecond * intervalMs / 1000)));
                        for (let i = 0; i < chunks; i++) {
                            const part = content.slice(Math.floor(i * content.length / chunks), Math.floor((i + 1) * content.length / chunks));
                            if (!send(tool ? { tool_calls: [{ index: 0, function: { arguments: part } }] } : { content: part })) break;
                            record({ type: "tokens", tokens: outputTokens / chunks, key });
                            if (i < chunks - 1) await Bun.sleep(intervalMs / speed);
                        }
                        if (!cancelled && !request.signal.aborted) {
                            send({}, tool ? "tool_calls" : "stop", usage);
                            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                            controller.close();
                            record({ type: "response", key, round, tool, outputTokens });
                        }
                    } catch (error) {
                        if (!cancelled) { record({ type: "error", error: String(error) }); controller.error(error); }
                    }
                },
                cancel() { cancelled = true; },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        },
    });
    if (server.port === 8372) { server.stop(true); throw new Error("Refusing reserved port 8372"); }
    return server;
}

if (import.meta.main) {
    const home = assertTrialHome();
    const run = process.env.LOAD_RUN!;
    const server = startProvider({ seed: Number(process.env.LOAD_SEED ?? 1), logPath: join(run, "provider.ndjson") });
    await Bun.write(join(run, "provider-ready.json"), JSON.stringify({ port: server.port, pid: process.pid, home }));
    const stop = () => { server.stop(true); process.exit(0); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}
