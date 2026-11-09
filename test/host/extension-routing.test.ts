import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage, type AssistantMessage, type ModelRequest } from "../../src/model/types.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

socketTest("master extensions reach the session owner before and after a move", async () => {
    const home = await mkdtemp(join(tmpdir(), "vhr-"));
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
    const configPath = join(home, "config.json");
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
        curated_models_url: "",
        model_assignments: {
            eco: { models: [{ name: "crow", provider: "openrouter", model: "faux/test" }] },
        },
        extensions: [{ path: extension, enabled: true, config: {} }],
    }));
    const config = loadVeraConfig({ path: configPath });
    const calls = new Map<string, { started: ReturnType<typeof deferred>; aborted: ReturnType<typeof deferred> }>();
    const createAdapter = () => ({
        stream(request: ModelRequest) {
            const user = [...request.messages].reverse().find((message) => message.role === "user");
            const text = JSON.stringify(user?.content ?? []);
            for (const [phrase, witness] of calls) {
                if (!text.includes(phrase)) continue;
                request.signal?.addEventListener("abort", () => witness.aborted.resolve(), { once: true });
                witness.started.resolve();
                return new FauxAdapter([reply()], { delayMs: 300 }).stream(request);
            }
            return new FauxAdapter([reply()]).stream(request);
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    process.env.VERA_HOME = home;
    try {
        host = await startResidentHost({ home, config, inProcessWorker: true, createAdapter });
        const registry = host.registry;
        const session = await registry.create({ workspace: home });
        const entry = registry.agents.get(session.id)!;
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Where is the map?" });
        while ((await client.receive()).type !== "turn_finished") {}
        client.close();
        client = undefined;
        await waitUntil(() => !session.attached && registry.deliveryTasks.size === 0);

        const request = (name: string, payload: JsonValue, signal = new AbortController().signal) =>
            host!.extensions.handleRequest("test.route", name, payload, signal);
        const title = { id: session.id, title: "Crow map" };
        expect(await request("title", title)).toBe("set");
        expect(await request("title", title)).toBe("named");
        const beforeAsk = await request("ask", { id: session.id, question: "What did the crow find?" });
        const beforeInvestigation = await request("investigate", { id: session.id, question: "Find the map." });
        expect(beforeInvestigation).toMatchObject({ outcome: "answered", text: "The crow found the map." });
        expect(await request("send", { id: session.id, text: "A message from the lookout." })).toBe("queued");
        await waitUntil(() => registry.deliveryTasks.size === 0 && session.idleForShutdown());

        await resumeAgentThroughHost(host.server.socketPath, entry.store.path);
        expect(registry.agents.has(session.id)).toBe(false);
        expect(await request("title", title)).toBe("named");
        expect(await request("ask", { id: session.id, question: "What did the crow find?" })).toEqual(beforeAsk);
        const afterInvestigation = await request("investigate", { id: session.id, question: "Find the map." });
        expect(afterInvestigation).toMatchObject({ outcome: "answered", text: "The crow found the map." });
        expect(await request("send", { id: session.id, text: "Another message from the lookout." })).toBe("queued");

        for (const name of ["ask", "investigate"] as const) {
            const phrase = `cancel ${name} at the owner`;
            const witness = { started: deferred(), aborted: deferred() };
            calls.set(phrase, witness);
            const controller = new AbortController();
            const pending = request(name, { id: session.id, question: phrase }, controller.signal);
            const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
            await within(witness.started.promise);
            controller.abort();
            await within(witness.aborted.promise);
            expect(await settled).toHaveProperty("error");
            calls.delete(phrase);
        }
        expect(await request("ask", { id: session.id, question: "What did the crow find?" })).toEqual(beforeAsk);
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        try {
            await host?.close();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function within(promise: Promise<void>): Promise<void> {
    await Promise.race([promise, Bun.sleep(5_000).then(() => { throw new Error("Timed out waiting for the owner"); })]);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the session to become idle");
        await Bun.sleep(5);
    }
}

function reply(): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "The crow found the map." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
