import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyAgentUpdate, beginTuiTurn, createTuiState } from "../../clients/tui/state.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import type { AttachedAgentClient } from "../../src/host/attached-client.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { SessionStore, WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";

socketAndLoopbackTest("a killed worker reconnects once, records its failed turn, and leaves another worker running", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h8r-"));
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests += 1;
            if (requests === 1) { entered.resolve(); await release.promise; }
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const pids = new Set<number>();
    const start = supervisor.startSessionWorkerSupervisor;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => start({
        ...options,
        onSpawn(pid) { pids.add(pid); options.onSpawn?.(pid); },
    }));
    let host: ResidentHost | undefined;
    const clients: AttachedAgentClient[] = [];
    try {
        host = await startResidentHost({
            home, webRoot, processWorker: true, processWorkerCount: 2, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
        if (host.annexPid !== undefined) pids.add(host.annexPid);
        const socket = host.server.socketPath;
        const first = await createAgentThroughHost(socket, home);
        const second = await createAgentThroughHost(socket, home);
        expect(first.location?.worker_id).not.toBe(second.location?.worker_id);
        const oldPid = (await requestHostIdentity(first.location!.socket_path))!.pid;
        const firstClient = await attachReconnectingAgent({ socketPath: () => socket, agentId: first.id, buildId: host.buildId, initialLocation: first.location });
        const secondClient = await attachReconnectingAgent({ socketPath: () => socket, agentId: second.id, buildId: host.buildId, initialLocation: second.location });
        clients.push(firstClient, secondClient);
        expect((await firstClient.receive()).type).toBe("history");
        expect((await secondClient.receive()).type).toBe("history");
        await firstClient.send({ type: "prompt", content: "Inspect the map." });
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Provider did not start"); })]);
        await secondClient.send({ type: "prompt", content: "Check the sails." });
        while ((await secondClient.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        process.kill(oldPid, "SIGKILL");
        const history = await receiveHistoryWithFailure(firstClient);
        expect(history.entries.filter((entry) => entry.kind === "error" && entry.detail === WORKER_EXIT_TURN_MESSAGE)).toHaveLength(1);
        expect(history.status).toBe("idle");
        expect(history.unsentPrompts).toEqual([{ content: "Inspect the map." }]);
        const tui = applyAgentUpdate(beginTuiTurn(createTuiState(), "Inspect the map."), history);
        expect(tui.working).toBe(false);
        expect(JSON.stringify(tui.entries).split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
        const replacement = await requestHostIdentity(first.location!.socket_path);
        expect(replacement?.pid).not.toBe(oldPid);
        expect(replacement?.worker_id).toBe(first.location?.worker_id);
        const path = join(home, "runtime", "sessions", `${first.id}.jsonl`);
        const log = await readFile(path, "utf8");
        expect(log.split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
        expect((await SessionStore.open(path)).messages().filter((message) =>
            message.role === "assistant" && message.errorMessage === WORKER_EXIT_TURN_MESSAGE)).toHaveLength(1);
        await firstClient.send({ type: "prompt", content: "Inspect the map again." });
        while ((await firstClient.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(requests).toBe(3);
    } finally {
        release.resolve();
        for (const client of clients) client.close();
        await host?.close();
        stub.stop(true);
        probe.mockRestore();
        try {
            const deadline = Date.now() + 5_000;
            while ([...pids].some(alive) && Date.now() < deadline) await Bun.sleep(10);
            expect([...pids].filter(alive)).toEqual([]);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 40_000);

async function receiveHistoryWithFailure(client: AttachedAgentClient) {
    const signal = AbortSignal.timeout(12_000);
    while (true) {
        const update = await client.receive(signal);
        if (update.type === "history" && update.entries.some((entry) => entry.kind === "error" && entry.detail === WORKER_EXIT_TURN_MESSAGE)) return update;
    }
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}
