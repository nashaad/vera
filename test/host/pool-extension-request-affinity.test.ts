import { expect } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

interface RequestResult {
    readonly prompt: string;
    readonly session: string;
    readonly owner: string;
    readonly workerSocket: string;
    readonly workerAnswer: unknown;
    readonly hostAnswer: unknown;
    readonly otherWorkerAnswer?: unknown;
}

async function runSessions(pool: boolean): Promise<readonly RequestResult[]> {
    const home = await mkdtemp("/private/tmp/vera-dev/h7ba-");
    const extension = join(home, "extension");
    await mkdir(extension);
    await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
        id: "test.affinity", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["hooks.turn_finished", "requests.handle"],
    }));
    await writeFile(join(extension, "extension.ts"), `
        export function activate(vera) {
            const sessions = new Map();
            vera.hooks.registerTurnFinished(({ sessionId, prompt }) => sessions.set(prompt, sessionId));
            vera.requests.handle("lookup", (payload) => sessions.get(payload) ?? "missing");
        }
    `);
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The map is aboard."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    const workerPids = new Set<number>();
    try {
        host = await startResidentHost({
            home, skipStartupDiscovery: true,
            ...(pool ? { processWorker: true, processWorkerCount: 2 } : {}),
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                extensions: [{ path: extension, enabled: true, config: {} }],
            },
        });
        const results: RequestResult[] = [];
        for (const prompt of pool ? ["crow map", "crow sails"] : ["crow map"]) {
            const created = await createAgentThroughHost(host.server.socketPath, home);
            const workerSocket = created.location?.socket_path ?? host.server.socketPath;
            const owner = created.location?.worker_id ?? "host";
            if (pool) workerPids.add((await requestHostIdentity(workerSocket))!.pid);
            client = await attachAgent({ socketPath: host.server.socketPath, agentId: created.id });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: prompt });
            while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
            const request = (socket: string) => requestExtensionThroughHost(
                socket, "test.affinity", "lookup", prompt, AbortSignal.timeout(5_000),
            );
            const deadline = Date.now() + 5_000;
            let workerAnswer: unknown;
            do {
                workerAnswer = await request(workerSocket);
                if (workerAnswer === created.id) break;
                await Bun.sleep(10);
            } while (Date.now() < deadline);
            results.push({
                prompt, session: created.id, owner, workerSocket, workerAnswer,
                hostAnswer: await request(host.server.socketPath),
            });
            client.close();
            client = undefined;
        }
        if (!pool) return results;
        expect(new Set(results.map((row) => row.owner)).size).toBe(2);
        return await Promise.all(results.map(async (result) => {
            const other = results.find((row) => row.owner !== result.owner)!;
            return {
                ...result,
                otherWorkerAnswer: await requestExtensionThroughHost(
                    other.workerSocket, "test.affinity", "lookup", result.prompt, AbortSignal.timeout(5_000),
                ),
            };
        }));
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        const started = [...workerPids, ...(annexPid === undefined ? [] : [annexPid])];
        console.log(JSON.stringify({ pool, stopped: started.filter((pid) => !running(pid)), stillLive: started.filter(running) }));
        expect(started.filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

socketAndLoopbackTest("pool-mode limitation: host requests cannot read worker-local session state", async () => {
    const single = await runSessions(false);
    const pool = await runSessions(true);
    console.log(JSON.stringify({ single, pool }));
    expect(pool.map((result) => result.otherWorkerAnswer)).toEqual(["missing", "missing"]);
    for (const result of single) {
        expect(result.workerAnswer).toBe(result.session);
        expect(result.hostAnswer).toBe(result.session);
    }
    for (const result of pool) {
        expect(result.workerAnswer).toBe(result.session);
        expect(result.hostAnswer).toBe("missing");
    }
}, 45_000);
