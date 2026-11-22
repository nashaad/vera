import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { HostRouter, type SessionEndpoint } from "../../src/host/pool/router.ts";
import { pruneScratch } from "../../src/host/scratch-retention.ts";
import { sessionEndpoint } from "../../src/host/session-host/endpoint.ts";
import type { SessionHost } from "../../src/host/session-host/types.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter, type ModelRequest } from "../../src/model/types.ts";
import { sessionScratchDir } from "../../src/session-scratch.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const source = { provider: "faux", api: "scripted", model: "test" } as const;

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
    return { role: "assistant", content, source, usage: emptyUsage(), stopReason };
}

test("@core a synchronous child keeps its parent's scratch owned while the parent closes", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-scratch-child-"));
    const sessions = join(home, "runtime", "sessions");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const childStarted = Promise.withResolvers<ModelRequest>();
    const childStream = new ModelEventStream();
    let childEnded = false;
    const finishChild = () => {
        if (childEnded) return;
        childEnded = true;
        const error = new Error("Child cancelled");
        childStream.push({ type: "error", error, message: response([], "aborted") });
    };
    const parentAdapter = new FauxAdapter([response([{
        type: "tool_call", id: "spawn-child", name: "subagent", input: { description: "Check the reef" },
    }], "tool_use")]);
    let calls = 0;
    const adapter: ModelAdapter = {
        stream(request) {
            calls += 1;
            if (calls === 1) return parentAdapter.stream(request);
            childStarted.resolve(request);
            childStream.push({ type: "start" });
            return childStream;
        },
    };
    const registry = new AgentRegistry({
        home,
        createAdapter: () => adapter,
        model: "faux/test",
        approvalMode: "auto",
        sessionPathForId: (id) => join(sessions, `${id}.jsonl`),
    });
    let closing: Promise<unknown> | undefined;
    try {
        const parent = await registry.create({ id: "parent", workspace: home });
        const attachment = parent.attach();
        attachment.send({ type: "prompt", content: "Start a child." });
        const request = await Promise.race([
            childStarted.promise,
            Bun.sleep(5_000).then(() => { throw new Error("Child did not start"); }),
        ]);
        const scratch = sessionScratchDir("parent", home);
        expect(request.systemPrompt).toContain(scratch);
        const entry = registry.agents.get("parent");
        if (entry === undefined) throw new Error("Parent is not resident");
        await entry.store.materialize();
        const old = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
        utimesSync(entry.store.path, old, old);
        const worker = { residents: async () => [] } as unknown as SessionEndpoint;
        const router = new HostRouter({
            host: sessionEndpoint({ registry } as SessionHost),
            worker,
            hostSocket: "/host.sock",
            workerSocket: "/worker.sock",
            buildId: "test",
        });
        const sweep = () => pruneScratch(join(home, "runtime", "scratch"), sessions, {
            removeIfUnowned: (id, detach) => router.removeScratchIfUnowned(id, detach),
        });
        expect((await sweep()).removedDirectories).toBe(0);
        closing = registry.closeAgent("parent");
        expect(parent.closed).toBe(true);
        expect(registry.agents.has("parent")).toBe(true);
        expect((await sweep()).removedDirectories).toBe(0);
        expect(existsSync(scratch)).toBe(true);
        finishChild();
        await closing;
        expect(registry.agents.has("parent")).toBe(false);
        utimesSync(entry.store.path, old, old);
        expect((await sweep()).removedDirectories).toBe(1);
        expect(existsSync(scratch)).toBe(false);
    } finally {
        finishChild();
        await closing;
        await registry.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
}, 10_000);
