import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { MAX_FRAME_BYTES } from "../../src/host/connection.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

const MCP = fileURLToPath(new URL("../../extensions/mcp", import.meta.url));
const SERVER = fileURLToPath(new URL("../extensions/fixtures/mcp-reconnect-server.ts", import.meta.url));

test("a worker receives an MCP result larger than one control frame", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7bg-"));
    const bytes = MAX_FRAME_BYTES + 1_024;
    let received = "";
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const body = await request.json() as { messages?: Array<{ role?: string; content?: unknown }> };
            const result = body.messages?.find((message) => message.role === "tool");
            if (typeof result?.content === "string") received = result.content;
            const delta = result === undefined
                ? { role: "assistant", tool_calls: [{ index: 0, id: "large", type: "function", function: {
                    name: "mcp_fixture_large", arguments: "{}",
                } }] }
                : { role: "assistant", content: "The crow received the result." };
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: result === undefined ? "tool_calls" : "stop" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    const pids = new Set<number>();
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                extensions: [{ path: MCP, enabled: true, config: { servers: {
                    fixture: { command: [process.execPath, SERVER], env: {
                        MCP_RECONNECT_FIXTURE: home, MCP_RECONNECT_LIFETIME_MS: "60000",
                        MCP_RECONNECT_RESULT_BYTES: String(bytes),
                    } },
                } } }],
            },
        });
        const events = (): string[] => readFileSync(join(home, "processes.log"), "utf8").trim().split("\n");
        for (const line of events()) if (line.startsWith("start ")) pids.add(Number(line.slice(6)));
        const agent = await createAgentThroughHost(host.server.socketPath, home);
        pids.add((await requestHostIdentity(agent.location!.socket_path))!.pid);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Read the crow's large map" });
        while (true) {
            const update = await client.receive(AbortSignal.timeout(30_000));
            if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                await client.send({ type: "ui_response", requestId: update.requestId,
                    response: { type: "tool_approval", decision: "allow_once" } });
            }
            if (update.type === "turn_finished") {
                expect(update.outcome).toBeUndefined();
                break;
            }
        }
        expect(received).toContain(`${bytes} bytes`);
        expect(received).toContain("bytes omitted from the middle of this result");
        expect(events().filter((line) => line.startsWith("start "))).toHaveLength(1);
        expect(events().filter((line) => line.startsWith("large "))).toHaveLength(1);
    } finally {
        client?.close();
        if (host?.annexPid !== undefined) pids.add(host.annexPid);
        await host?.close();
        stub.stop(true);
        const running = (pid: number): boolean => {
            try { process.kill(pid, 0); return true; } catch { return false; }
        };
        for (const pid of pids) if (running(pid)) process.kill(pid, "SIGTERM");
        const deadline = Date.now() + 5_000;
        while ([...pids].some(running) && Date.now() < deadline) await Bun.sleep(10);
        console.log(JSON.stringify({ stopped: [...pids].filter((pid) => !running(pid)), stillLive: [...pids].filter(running) }));
        expect([...pids].filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 60_000);
