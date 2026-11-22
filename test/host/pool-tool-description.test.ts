import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { hostSocketPath } from "../../src/host/startup-failure.ts";

const BROWSER = fileURLToPath(new URL("../../extensions/builtin-browser", import.meta.url));
const ASK_SENTENCE = "If a tool named browser is also available, ask the user once which browser to use before the first call, and keep the answer for this conversation.";
const PANE_SENTENCE = "If a tool named browser is also available, use this tool unless the user asks for Chrome.";

interface CapturedRequest {
    readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string; readonly description?: string } }>;
    readonly messages?: ReadonlyArray<{ readonly role?: string }>;
}

function browserDescription(request: CapturedRequest | undefined): string | undefined {
    return request?.tools?.find((tool) => tool.function?.name === "builtin_browser")?.function?.description;
}

function withTools(requests: readonly CapturedRequest[]): CapturedRequest[] {
    return requests.filter((request) => (request.tools?.length ?? 0) > 0);
}

async function prompt(client: AttachedAgentClient, content: string): Promise<void> {
    await client.send({ type: "prompt", content });
    while (true) {
        const update = await client.receive(AbortSignal.timeout(15_000));
        if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
            await client.send({ type: "ui_response", requestId: update.requestId,
                response: { type: "tool_approval", decision: "allow_once" } });
        }
        if (update.type === "turn_finished") return;
    }
}

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

socketAndLoopbackTest("@core a host Browser description change reaches running and later workers", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7bd-"));
    const requests: CapturedRequest[] = [];
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const body = await request.json() as CapturedRequest;
            requests.push(body);
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta: { role: "assistant", content: "The crow answered." }, finish_reason: "stop" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    const workerPids: number[] = [];
    try {
        host = await startResidentHost({
            home, skipStartupDiscovery: true, processWorker: true, processWorkerCount: 2,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                extensions: [{ path: BROWSER, enabled: true, config: {} }],
            },
        });
        const socket = host.server.socketPath;
        const first = await createAgentThroughHost(socket, home);
        workerPids.push((await requestHostIdentity(first.location?.socket_path ?? socket))!.pid);
        client = await attachAgent({ socketPath: socket, agentId: first.id });
        expect((await client.receive()).type).toBe("history");

        await prompt(client, "crow first");
        const firstRequest = withTools(requests).at(-1);
        expect(browserDescription(firstRequest)).toEndWith(ASK_SENTENCE);
        const unchanged = JSON.stringify(firstRequest!.tools);

        await prompt(client, "crow second");
        expect(JSON.stringify(withTools(requests).at(-1)!.tools)).toBe(unchanged);

        expect(await requestExtensionThroughHost(socket, "vera.builtin-browser", "settings",
            { defaultBrowser: "pane" }, AbortSignal.timeout(10_000)))
            .toEqual({ enabled: false, offBehavior: "ask", defaultBrowser: "pane" });

        await prompt(client, "crow third");
        expect(browserDescription(withTools(requests).at(-1))).toEndWith(PANE_SENTENCE);
        client.close();
        client = undefined;

        const second = await createAgentThroughHost(socket, home);
        const secondWorker = await requestHostIdentity(second.location?.socket_path ?? socket);
        const secondPid = secondWorker!.pid;
        expect(secondPid).not.toBe(workerPids[0]);
        workerPids.push(secondPid);
        client = await attachAgent({ socketPath: socket, agentId: second.id });
        expect((await client.receive()).type).toBe("history");
        await prompt(client, "crow fourth");
        expect(browserDescription(withTools(requests).at(-1))).toEndWith(PANE_SENTENCE);
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        const started = [...workerPids, ...(annexPid === undefined ? [] : [annexPid])];
        expect(started.filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 60_000);

socketAndLoopbackTest("@core a description change during worker startup reaches that worker", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7be-"));
    const requests: CapturedRequest[] = [];
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const body = await request.json() as CapturedRequest;
            requests.push(body);
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta: { role: "assistant", content: "The crow waited." }, finish_reason: "stop" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    const pids = new Set<number>();
    const start = supervisor.startSessionWorkerSupervisor;
    const release = Promise.withResolvers<void>();
    let paused = false;
    const probe = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        const worker = await start({
            ...options,
            onSpawn(pid, startedAt) { pids.add(pid); options.onSpawn?.(pid, startedAt); },
        });
        if (options.index !== 0) return worker;
        const request = worker.peer.request.bind(worker.peer);
        worker.peer.request = async <T>(method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<T> => {
            if (method === "worker.setTurnsHeld" && !paused) {
                paused = true;
                await release.promise;
            }
            return await request<T>(method, args, signal);
        };
        return worker;
    });
    let starting: Promise<Awaited<ReturnType<typeof startResidentHost>>> | undefined;
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    try {
        starting = startResidentHost({
            home, skipStartupDiscovery: true, processWorker: true, processWorkerCount: 2,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                extensions: [{ path: BROWSER, enabled: true, config: {} }],
            },
        });
        void starting.catch(() => {});
        const deadline = Date.now() + 10_000;
        while (!paused) {
            if (Date.now() >= deadline) throw new Error("Worker startup did not reach setTurnsHeld");
            await Bun.sleep(10);
        }
        expect(await requestExtensionThroughHost(hostSocketPath(home), "vera.builtin-browser", "settings",
            { defaultBrowser: "pane" }, AbortSignal.timeout(10_000)))
            .toEqual({ enabled: false, offBehavior: "ask", defaultBrowser: "pane" });
        release.resolve();
        host = await starting;
        if (host.annexPid !== undefined) pids.add(host.annexPid);
        const sessions = [
            await createAgentThroughHost(host.server.socketPath, home),
            await createAgentThroughHost(host.server.socketPath, home),
        ];
        const session = sessions.find((candidate) => candidate.location?.worker_id === "w0");
        if (session === undefined) throw new Error("No session started on the paused worker");
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await prompt(client, "crow after the startup change");
        expect(browserDescription(withTools(requests).at(-1))).toEndWith(PANE_SENTENCE);
    } finally {
        release.resolve();
        client?.close();
        probe.mockRestore();
        if (host === undefined && starting !== undefined) {
            try { host = await starting; } catch {}
            if (host?.annexPid !== undefined) pids.add(host.annexPid);
        }
        await host?.close();
        stub.stop(true);
        expect([...pids].filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}, 60_000);
