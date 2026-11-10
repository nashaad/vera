import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

const MCP = fileURLToPath(new URL("../../extensions/mcp", import.meta.url));
const SERVER = fileURLToPath(new URL("../extensions/fixtures/mcp-reconnect-server.ts", import.meta.url));
const PINGER = fileURLToPath(new URL("./fixtures/identity-pinger.ts", import.meta.url));

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP result");
        await Bun.sleep(10);
    }
}

socketAndLoopbackTest("a ten-megabyte MCP result keeps host identity responsive", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7bl-"));
    await writeFile(join(home, "hold-result"), "");
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const body = await request.json() as { messages?: Array<{ role?: string }> };
            const answered = body.messages?.some((message) => message.role === "tool") === true;
            const delta = answered ? { role: "assistant", content: "The crow received the result." }
                : { role: "assistant", tool_calls: [{ index: 0, id: "large", type: "function", function: {
                    name: "mcp_fixture_large", arguments: "{}",
                } }] };
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: answered ? "stop" : "tool_calls" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let pinger: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    const pids = new Set<number>();
    const log = join(home, "processes.log");
    const events = (): string[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                extensions: [{ path: MCP, enabled: true, config: { servers: {
                    fixture: { command: [process.execPath, SERVER], env: {
                        MCP_RECONNECT_FIXTURE: home, MCP_RECONNECT_LIFETIME_MS: "60000",
                    } },
                } } }],
            },
        });
        const agent = await createAgentThroughHost(host.server.socketPath, home);
        pids.add((await requestHostIdentity(agent.location!.socket_path))!.pid);
        for (const line of events()) if (line.startsWith("start ")) pids.add(Number(line.slice(6)));
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Read the crow's large map" });
        const turn = (async () => {
            while (true) {
                const update = await client!.receive(AbortSignal.timeout(20_000));
                if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                    await client!.send({ type: "ui_response", requestId: update.requestId,
                        response: { type: "tool_approval", decision: "allow_once" } });
                }
                if (update.type === "turn_finished") return update.outcome;
            }
        })();
        await waitFor(() => events().some((line) => line.startsWith("large ")));
        pinger = Bun.spawn([process.execPath, PINGER, host.server.socketPath, "2500"], {
            cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        pids.add(pinger.pid);
        const output = new Response(pinger.stdout).text();
        const errors = new Response(pinger.stderr).text();
        await Bun.sleep(250);
        await rm(join(home, "hold-result"));
        expect(await turn).toBeUndefined();
        expect(await pinger.exited).toBe(0);
        const result = JSON.parse(await output) as { samples: number[]; misses: number };
        expect(await errors).toBe("");
        const ordered = [...result.samples].sort((left, right) => left - right);
        const p90 = ordered[Math.floor((ordered.length - 1) * 0.9)] ?? Infinity;
        const max = ordered.at(-1) ?? Infinity;
        console.log(JSON.stringify({ samples: ordered.length, misses: result.misses, p90, max }));
        expect(ordered.length).toBeGreaterThan(5);
        expect(result.misses).toBe(0);
        expect(p90).toBeLessThan(100);
        expect(max).toBeLessThan(250);
        expect(events().filter((line) => line.startsWith("start "))).toHaveLength(1);
        expect(events().filter((line) => line.startsWith("large "))).toHaveLength(1);
    } finally {
        await rm(join(home, "hold-result"), { force: true });
        client?.close();
        if (pinger !== undefined && pinger.exitCode === null) pinger.kill();
        await pinger?.exited;
        if (host?.annexPid !== undefined) pids.add(host.annexPid);
        await host?.close();
        stub.stop(true);
        for (const line of events()) if (line.startsWith("start ")) pids.add(Number(line.slice(6)));
        for (const pid of pids) if (running(pid)) process.kill(pid, "SIGTERM");
        await waitFor(() => [...pids].every((pid) => !running(pid)));
        console.log(JSON.stringify({ stopped: [...pids].filter((pid) => !running(pid)), stillLive: [...pids].filter(running) }));
        expect([...pids].filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 40_000);
