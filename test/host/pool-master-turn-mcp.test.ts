import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

const MCP = fileURLToPath(new URL("../../extensions/mcp", import.meta.url));
const SERVER = fileURLToPath(new URL("../extensions/fixtures/mcp-reconnect-server.ts", import.meta.url));

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a master-owned per-turn worker does not start another MCP server", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h7bm-");
    const previous = process.env.VERA_WORKER_EXTENSIONS;
    process.env.VERA_WORKER_EXTENSIONS = "1";
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            started.resolve();
            await release.promise;
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
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
                    fixture: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: home } },
                } } }],
            },
        });
        pids.add((await requestHostIdentity(join(home, "runtime", "w0.sock")))!.pid);
        const starts = (): string[] => readFileSync(join(home, "processes.log"), "utf8").split("\n")
            .filter((line) => line.startsWith("start "));
        expect(starts()).toHaveLength(1);
        pids.add(Number(starts()[0]!.slice(6)));
        const agent = await host.registry.create({ workspace: home });
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Chart the crow course" });
        await Promise.race([started.promise, Bun.sleep(15_000).then(() => { throw new Error("Provider was not reached"); })]);
        const worker = host.registry.agents.get(agent.id)!.worker;
        expect(worker).toBeDefined();
        pids.add(worker!.pid);
        if (worker?.supervisor?.pid !== null && worker?.supervisor?.pid !== undefined) pids.add(worker.supervisor.pid);
        expect(starts()).toHaveLength(1);
        release.resolve();
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
    } finally {
        release.resolve();
        client?.close();
        if (host?.annexPid !== undefined) pids.add(host.annexPid);
        await host?.close();
        stub.stop(true);
        if (previous === undefined) delete process.env.VERA_WORKER_EXTENSIONS;
        else process.env.VERA_WORKER_EXTENSIONS = previous;
        const deadline = Date.now() + 5_000;
        while ([...pids].some(running) && Date.now() < deadline) await Bun.sleep(10);
        console.log(JSON.stringify({ stopped: [...pids].filter((pid) => !running(pid)), stillLive: [...pids].filter(running) }));
        expect([...pids].filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);
