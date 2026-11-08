import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { addComment, writeArtifact } from "../../extensions/artifacts/artifact-store.ts";
import { readAnnexUrlThroughHost } from "../../src/annex/host-client.ts";
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { extensionStorage } from "../../src/extensions/storage.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestExtensionThroughHost } from "../../src/host/extension-request-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

interface PoolFixture {
    readonly home: string;
    readonly socket: string;
    readonly requests: readonly string[];
    create(): ReturnType<typeof createAgentThroughHost>;
}

async function withPool(run: (pool: PoolFixture) => Promise<readonly number[]>): Promise<void> {
    const home = await mkdtemp("/private/tmp/vera-dev/h7br-");
    const webRoot = join(home, "web");
    const requests: string[] = [];
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const body = await request.text();
            requests.push(body);
            const decoded = JSON.parse(body) as { messages?: Array<{ role?: string }> };
            const lastUser = decoded.messages?.findLastIndex((message) => message.role === "user") ?? -1;
            const createArtifact = JSON.stringify(decoded.messages?.[lastUser]).includes("Create a crow artifact");
            const answered = decoded.messages?.slice(lastUser + 1).some((message) => message.role === "tool") === true;
            const content = body.includes("Phase 1") ? "1: Repaired the crow mast" : "The crow received the comment.";
            const delta = createArtifact && !answered
                ? { role: "assistant", tool_calls: [{ index: 0, id: "artifact", type: "function", function: {
                    name: "artifact_write", arguments: JSON.stringify({ name: "raid", markdown: "# Crow map" }),
                } }] }
                : { role: "assistant", content };
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: createArtifact && !answered ? "tool_calls" : "stop" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let workerPids: readonly number[] = [];
    try {
        await mkdir(webRoot);
        await Promise.all([
            writeFile(join(webRoot, "index.html"), "<!doctype html><title>Vera</title>"),
            writeFile(join(webRoot, "main.js"), ""),
            writeFile(join(webRoot, "styles.css"), ""),
        ]);
        host = await startResidentHost({
            home, webRoot, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                model_assignments: { snappy: { models: [{ name: "crow", provider: "stub", model: "stub-model" }] } },
            },
        });
        const socket = host.server.socketPath;
        workerPids = [(await requestHostIdentity(join(home, "runtime", "w0.sock")))!.pid];
        workerPids = await run({ home, socket, requests, create: () => createAgentThroughHost(socket, home) });
    } finally {
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        const started = [...workerPids, ...(annexPid === undefined ? [] : [annexPid])];
        const stopped = started.filter((pid) => !running(pid));
        const stillLive = started.filter(running);
        console.log(JSON.stringify({ stopped, stillLive }));
        await rm(home, { recursive: true, force: true });
        expect(annexPid).toBeDefined();
        expect(stopped).toContain(annexPid!);
        expect(stillLive).toEqual([]);
    }
}

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test("the master serves recap label requests in pool mode", async () => {
    await withPool(async ({ socket, requests, create }) => {
        const agent = await create();
        const workerPid = (await requestHostIdentity(agent.location!.socket_path))!.pid;
        const result = await requestExtensionThroughHost(socket, "vera.recap", "label", {
            earlier: [], phases: [{ prompts: ["Repair the mast"], done: [], files: [], commits: [] }],
        }, AbortSignal.timeout(10_000));
        expect(result).toEqual(["Repaired the crow mast"]);
        expect(requests).toHaveLength(1);
        return [workerPid];
    });
}, 30_000);

test("the master sends an artifact comment to its worker session", async () => {
    await withPool(async ({ home, socket, requests, create }) => {
        const agent = await create();
        const workerPid = (await requestHostIdentity(agent.location!.socket_path))!.pid;
        const root = extensionStorage("vera.artifacts", { profile: home, machine: join(home, "machine") }).profile;
        const ref = { sessionId: agent.id, name: "raid" };
        writeArtifact(root, ref, "# Raid\n\n- Inspect the mast");
        const comment = addComment(root, ref, { quote: "- Inspect the mast", index: 1, body: "Check the crow rigging" });
        let client: AttachedAgentClient | undefined;
        try {
            client = await attachAgent({ socketPath: socket, agentId: agent.id });
            expect((await client.receive()).type).toBe("history");
            const outcome = await requestExtensionThroughHost(socket, "vera.artifacts", "send-comment", {
                session: agent.id, artifact: ref.name, id: comment.id,
            }, AbortSignal.timeout(10_000));
            expect(outcome).toBe("queued");
            while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
            expect(requests.filter((request) => request.includes("Check the crow rigging"))).toHaveLength(1);
        } finally {
            client?.close();
        }
        return [workerPid];
    });
}, 30_000);

test("a worker artifact tool returns the master's annex page URL", async () => {
    await withPool(async ({ socket, create }) => {
        const agent = await create();
        const workerPid = (await requestHostIdentity(agent.location!.socket_path))!.pid;
        const annex = await readAnnexUrlThroughHost(socket);
        expect("url" in annex).toBe(true);
        let client: AttachedAgentClient | undefined;
        try {
            client = await attachAgent({ socketPath: socket, agentId: agent.id });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "Create a crow artifact" });
            let output = "";
            while (true) {
                const update = await client.receive(AbortSignal.timeout(10_000));
                if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                    await client.send({ type: "ui_response", requestId: update.requestId,
                        response: { type: "tool_approval", decision: "allow_once" } });
                }
                if (update.type === "tool_finished" && update.tool === "artifact_write") output = update.output ?? "";
                if (update.type === "turn_finished") break;
            }
            expect(output).toContain("Artifact page: http");
            expect(output).toContain("/x/vera.artifacts/artifacts");
            if ("url" in annex) expect(output).toContain(annex.url.replace(/\/$/, ""));
        } finally {
            client?.close();
        }
        return [workerPid];
    });
}, 30_000);
