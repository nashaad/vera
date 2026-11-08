import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { branchAgentThroughHost, createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, PromptRejectedError, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import { connectHost } from "../../src/host/connection.ts";
import { HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE } from "../../src/host/capabilities.ts";
import { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { CRASH_CUT_MESSAGE, SessionStore } from "../../src/store/session-store.ts";

test("a real worker serves sessions and preserves an existing owner", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs4-pool-");
    let turns = 0;
    let modelLists = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
                modelLists += 1;
                return new Response("not found", { status: 404 });
            }
            turns += 1;
            const body = [
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
                "", "data: [DONE]", "",
            ].join("\n");
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let workerPid: number | undefined;
    const releaseWrite = Promise.withResolvers<void>();
    let write: Promise<void> | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto",
                curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
        const socket = host.server.socketPath;
        const created = await createAgentThroughHost(socket, home);
        const workerLocation = await locate(socket, created.id);
        expect(workerLocation).toMatchObject({ type: "agent_location", worker_id: "w0" });
        const workerIdentity = await requestHostIdentity(workerLocation.socket_path);
        expect(workerIdentity).toMatchObject({ role: "worker", worker_id: "w0", worker_index: 0, worker_count: 1 });
        workerPid = workerIdentity!.pid;
        expect(workerPid).not.toBe(process.pid);

        const master = await host.registry.create({ workspace: home });
        const entry = host.registry.agents.get(master.id)!;
        const writing = Promise.withResolvers<void>();
        write = entry.store.exclusively(async () => { writing.resolve(); await releaseWrite.promise; });
        await writing.promise;
        const resumed = await resumeAgentThroughHost(socket, entry.store.path);
        expect(resumed.id).toBe(master.id);
        expect(resumed.location?.worker_id).toBe("host");
        expect(host.registry.agents.has(master.id)).toBe(true);
        releaseWrite.resolve();
        await write;
        expect((await locate(socket, master.id)).worker_id).toBe("host");
        client = await attachAgent({ socketPath: socket, agentId: created.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Where is the map?" });
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(turns).toBe(1);
        expect(modelLists).toBe(0);
    } finally {
        releaseWrite.resolve();
        await write?.catch(() => {});
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

test("abrupt socket closure releases attachments on both owners", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs4-drop-");
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
    let workerPid: number | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
        const socket = host.server.socketPath;
        const master = await host.registry.create({ workspace: home });
        client = await attachAgent({ socketPath: socket, agentId: master.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Find the map." });
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(master.attached).toBe(true);
        client.close();
        client = undefined;
        await waitFor(() => !master.attached);

        const worker = await createAgentThroughHost(socket, home);
        const location = await locate(socket, worker.id);
        workerPid = (await requestHostIdentity(location.socket_path))!.pid;
        client = await attachAgent({
            socketPath: socket, agentId: worker.id, interactive: true, clientId: "dropped-viewer",
            requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
        });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Find the map." });
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        client.close();
        client = undefined;
        const deadline = Date.now() + 5_000;
        while (true) {
            client = await attachAgent({
                socketPath: socket, agentId: worker.id, interactive: true, clientId: "next-viewer",
                requestedCapabilities: [HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE],
            });
            expect((await client.receive()).type).toBe("history");
            const outcome = await client.release!("stop_if_last");
            client.close();
            client = undefined;
            if (outcome.outcome === "stopped") break;
            if (Date.now() >= deadline) throw new Error("The dropped worker attachment was not released");
            await Bun.sleep(25);
        }
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 25_000);

test("a killed session worker repairs its turn and re-offers a queued prompt once", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs4-crash-");
    const started = deferred();
    const release = deferred();
    let hold = true;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            if (hold) { started.resolve(); await release.promise; }
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const options = {
        home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
        config: {
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        },
    } as const;
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    const workers: number[] = [];
    const annexes: number[] = [];
    try {
        host = await startResidentHost(options);
        if (host.annexPid !== undefined) annexes.push(host.annexPid);
        const session = await createAgentThroughHost(host.server.socketPath, home);
        const location = await locate(host.server.socketPath, session.id);
        const workerPid = (await requestHostIdentity(location.socket_path))!.pid;
        workers.push(workerPid);
        const path = join(home, "runtime", "sessions", `${session.id}.jsonl`);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Inspect the deck." });
        await within(started.promise);
        await client.send({ type: "prompt", content: "Check the sails." });
        expect((await SessionStore.open(path)).queuedPrompts()).toMatchObject([{ content: "Check the sails." }]);

        expect(await requestHostIdentity(location.socket_path)).toMatchObject({ pid: workerPid, role: "worker" });
        process.kill(workerPid, "SIGKILL");
        await waitFor(() => !processAlive(workerPid));
        await waitFor(() => client!.closed);
        client.close();
        client = undefined;
        hold = false;
        release.resolve();
        await host.close();
        host = undefined;

        host = await startResidentHost(options);
        if (host.annexPid !== undefined) annexes.push(host.annexPid);
        expect((await resumeAgentThroughHost(host.server.socketPath, path)).id).toBe(session.id);
        const restarted = await locate(host.server.socketPath, session.id);
        workers.push((await requestHostIdentity(restarted.socket_path))!.pid);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
        const history = await client.receive();
        expect(history).toMatchObject({
            type: "history", unsentPrompts: [{ content: "Inspect the deck." }, { content: "Check the sails." }],
        });
        expect((await readFile(path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        await client.send({ type: "prompt", content: "Continue the voyage." });
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        await client.detach();
        client.close();
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
        const later = await client.receive();
        expect(later.type).toBe("history");
        if (later.type !== "history") throw new Error("Missing history");
        expect(later.unsentPrompts).toBeUndefined();
        expect((await readFile(path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
    } finally {
        release.resolve();
        client?.close();
        await host?.close();
        stub.stop(true);
        try {
            for (const pid of [...workers, ...annexes]) expect(() => process.kill(pid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

test("a worker durably accepts, rejects, withdraws, and clears queued prompts", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs4-queue-");
    const started = deferred();
    const release = deferred();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            started.resolve();
            await Promise.race([
                release.promise,
                new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return new Response('data: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    let workerPid: number | undefined;
    let path: string | undefined;
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
        const socket = host.server.socketPath;
        const session = await createAgentThroughHost(socket, home);
        const location = await locate(socket, session.id);
        workerPid = (await requestHostIdentity(location.socket_path))!.pid;
        path = join(home, "runtime", "sessions", `${session.id}.jsonl`);
        client = await attachAgent({ socketPath: socket, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Inspect the deck." });
        await within(started.promise);
        await chmod(path, 0o400);
        const rejection = await client.send({ type: "prompt", content: "Cannot save." }).catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(PromptRejectedError);
        expect((rejection as PromptRejectedError).reason).toBe("Could not save the queued prompt.");
        expect((await SessionStore.open(path)).queuedPrompts()).toEqual([]);
        await chmod(path, 0o600);

        await client.send({ type: "prompt", content: "Recall this." });
        expect((await SessionStore.open(path)).queuedPrompts()).toMatchObject([{ content: "Recall this." }]);
        await client.send({ type: "withdraw_queued_prompt", requestId: "recall" });
        let update = await client.receive(AbortSignal.timeout(5_000));
        while (update.type !== "prompt_withdrawn") update = await client.receive(AbortSignal.timeout(5_000));
        expect(update).toMatchObject({ requestId: "recall", content: "Recall this." });
        expect((await SessionStore.open(path)).queuedPrompts()).toEqual([]);

        await client.send({ type: "prompt", content: "Clear this." });
        expect((await SessionStore.open(path)).queuedPrompts()).toMatchObject([{ content: "Clear this." }]);
        expect(await closeAgentThroughHost(socket, session.id)).toEqual({ status: "closed", sessionRetained: true });
        expect((await SessionStore.open(path)).queuedPrompts()).toEqual([]);
        expect((await SessionStore.open(path)).unsentPrompts()).toEqual([]);
    } finally {
        release.resolve();
        if (path !== undefined) await chmod(path, 0o600).catch(() => {});
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

test("extension calls cross the process boundary and blocked moves attach to the owner", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs4-ext-");
    const previousHome = process.env.VERA_HOME;
    const extension = join(home, "extensions", "route-test");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
        id: "test.route", sdk: "1", version: "1.0.0", entrypoint: "extension.ts",
        capabilities: ["requests.handle", "sessions.title", "sessions.send", "sessions.ask", "agents.investigate"],
    }));
    await writeFile(join(extension, "extension.ts"), `export function activate(api) {
    api.requests.handle("title", (p) => api.sessions.setTitle(p.id, p.title));
    api.requests.handle("send", (p) => api.sessions.send(p.id, p.text));
    api.requests.handle("ask", (p, {signal}) => api.sessions.ask({sessionId: p.id, question: p.question, signal}));
    api.requests.handle("investigate", (p, {signal}) => api.agents.investigate({sessionId: p.id, question: p.question, timeoutMs: 10000, signal}));
}`);
    const holds = new Map<string, { started: ReturnType<typeof deferred>; aborted: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const body = await request.text();
            for (const [phrase, hold] of holds) {
                if (!body.includes(phrase)) continue;
                hold.started.resolve();
                await Promise.race([
                    hold.release.promise,
                    new Promise<void>((resolve) => request.signal.addEventListener("abort", () => {
                        hold.aborted.resolve();
                        resolve();
                    }, { once: true })),
                ]);
            }
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const configPath = join(home, "config.json");
    await writeFile(configPath, JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        model_assignments: { eco: { models: [{ name: "crow", provider: "stub", model: "stub-model" }] } },
        extensions: [{ path: extension, enabled: true, config: {} }],
    }));
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let workerPid: number | undefined;
    let client: AttachedAgentClient | undefined;
    const branchGate = deferred();
    let branch: Promise<unknown> | undefined;
    process.env.VERA_HOME = home;
    try {
        host = await startResidentHost({ home, configPath, config: loadVeraConfig({ path: configPath }), processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true });
        const socket = host.server.socketPath;
        const worker = await createAgentThroughHost(socket, home);
        const location = await locate(socket, worker.id);
        workerPid = (await requestHostIdentity(location.socket_path))!.pid;
        const master = await host.registry.create({ workspace: home });
        const path = host.registry.agents.get(master.id)!.store.path;
        for (const id of [master.id, worker.id]) {
            client = await attachAgent({ socketPath: socket, agentId: id });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "Where is the map?" });
            while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
            await client.detach();
            client.close();
            client = undefined;
        }
        await waitFor(() => !master.attached);
        const invoke = (name: string, id: string, question = "Where is the map?", signal = new AbortController().signal) =>
            host!.extensions.handleRequest("test.route", name, { id, question, title: "Crow map", text: "Message from the lookout." }, signal);
        expect(await invoke("title", worker.id)).toBe("set");
        expect(await invoke("ask", worker.id)).toMatchObject({ text: "The crow found the map." });
        expect(await invoke("investigate", worker.id)).toMatchObject({ outcome: "answered", text: "The crow found the map." });
        expect(await invoke("send", worker.id)).toBe("queued");

        for (const name of ["ask", "investigate"] as const) {
            const phrase = `cancel ${name} at the worker`;
            const hold = { started: deferred(), aborted: deferred(), release: deferred() };
            holds.set(phrase, hold);
            const controller = new AbortController();
            const pending = invoke(name, worker.id, phrase, controller.signal);
            const settled = pending.then(() => "resolved", () => "rejected");
            await within(hold.started.promise);
            controller.abort();
            await within(hold.aborted.promise);
            expect(await settled).toBe("rejected");
            holds.delete(phrase);
        }
        expect(await invoke("ask", worker.id)).toMatchObject({ text: "The crow found the map." });

        const fromWorker = (name: string, question: string, signal = new AbortController().signal) =>
            requestExtensionThroughHost(location.socket_path, "test.route", name,
                { id: master.id, question, title: "Master map", text: "Message from the lookout." }, signal);
        expect(await fromWorker("title", "unused")).toBe("set");
        for (const name of ["ask", "investigate"] as const) {
            const phrase = `cancel ${name} at the master`;
            const hold = { started: deferred(), aborted: deferred(), release: deferred() };
            holds.set(phrase, hold);
            const controller = new AbortController();
            const pending = fromWorker(name, phrase, controller.signal);
            const settled = pending.then(() => "resolved", () => "rejected");
            await within(hold.started.promise);
            controller.abort();
            await within(hold.aborted.promise);
            expect(await settled).toBe("rejected");
            holds.delete(phrase);
        }
        expect(await fromWorker("ask", "Where is the map?")).toMatchObject({ text: "The crow found the map." });

        const hold = { started: deferred(), aborted: deferred(), release: deferred() };
        holds.set("hold master ask", hold);
        const controller = new AbortController();
        const pending = invoke("ask", master.id, "hold master ask", controller.signal);
        const settled = pending.then(() => "resolved", () => "rejected");
        await within(hold.started.promise);
        expect((await resumeAgentThroughHost(socket, path)).id).toBe(master.id);
        expect(host.registry.agents.has(master.id)).toBe(true);
        expect((await locate(socket, master.id)).worker_id).toBe("host");
        client = await attachAgent({ socketPath: socket, agentId: master.id });
        expect((await client.receive()).type).toBe("history");
        await client.detach();
        client.close();
        client = undefined;
        controller.abort();
        await within(hold.aborted.promise);
        expect(await settled).toBe("rejected");
        holds.delete("hold master ask");

        const branching = deferred();
        const originalBranch = host.registry.branch;
        host.registry.branch = async (...args) => {
            branching.resolve();
            await branchGate.promise;
            return await originalBranch.apply(host!.registry, args);
        };
        branch = branchAgentThroughHost(socket, master.id, "at", undefined, { lifetime: "ephemeral" });
        await within(branching.promise);
        expect((await resumeAgentThroughHost(socket, path)).id).toBe(master.id);
        expect(host.registry.agents.has(master.id)).toBe(true);
        expect((await locate(socket, master.id)).worker_id).toBe("host");
        client = await attachAgent({ socketPath: socket, agentId: master.id });
        expect((await client.receive()).type).toBe("history");
        await client.detach();
        client.close();
        client = undefined;
        branchGate.resolve();
        await branch;
    } finally {
        for (const hold of holds.values()) hold.release.resolve();
        branchGate.resolve();
        await branch?.catch(() => {});
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(home, { recursive: true, force: true });
        }
    }
}, 40_000);

async function locate(socketPath: string, id: string): Promise<{ socket_path: string; worker_id: string }> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "locate_agent", agent_id: id });
        return await connection.receive() as { socket_path: string; worker_id: string };
    } finally {
        connection.close();
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for session release");
        await Bun.sleep(10);
    }
}

function deferred() { return Promise.withResolvers<void>(); }

function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

async function within(promise: Promise<void>): Promise<void> {
    await Promise.race([promise, Bun.sleep(5_000).then(() => { throw new Error("Timed out waiting for the owner"); })]);
}
