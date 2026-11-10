import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

const MCP = fileURLToPath(new URL("../../extensions/mcp", import.meta.url));
const SERVER = fileURLToPath(new URL("../extensions/fixtures/mcp-reconnect-server.ts", import.meta.url));

interface CaseResult {
    readonly tools: readonly unknown[];
    readonly owners: readonly string[];
    readonly workerPids: readonly number[];
    readonly serverPid: number;
    readonly outputs: readonly string[];
}

async function runCase(pool: boolean): Promise<CaseResult> {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7bc-"));
    const local = join(home, "local");
    await mkdir(local);
    await writeFile(join(local, "vera.extension.json"), JSON.stringify({
        id: "test.local", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
        capabilities: ["tools.register", "commands.register"],
    }));
    await writeFile(join(local, "extension.ts"), `
        export function activate(vera) {
            vera.tools.register({
                name: "local_probe", description: "Return the process id.",
                inputSchema: { type: "object", properties: {} },
                run() { return { output: String(process.pid) }; },
            });
            vera.commands.register({
                name: "local-pid", description: "Return the process id.", usage: "/local-pid",
                run() { return { kind: "text", text: String(process.pid) }; },
            });
        }
    `);
    const requests: Array<{ tools?: readonly unknown[]; messages?: Array<{ role?: string }> }> = [];
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            const body = await request.json() as { tools?: readonly unknown[]; messages?: Array<{ role?: string }> };
            requests.push(body);
            const lastUser = body.messages?.findLastIndex((message) => message.role === "user") ?? -1;
            const answered = body.messages?.slice(lastUser + 1).some((message) => message.role === "tool") === true;
            const localCall = JSON.stringify(body.messages?.[lastUser]).includes("crow local");
            const slowCall = JSON.stringify(body.messages?.[lastUser]).includes("crow slow");
            const delta = answered ? { role: "assistant", content: "The crow received the result." }
                : { role: "assistant", tool_calls: [{ index: 0, id: slowCall ? "call-slow" : localCall ? "call-local" : "call-mcp", type: "function", function: {
                    name: localCall ? "local_probe" : slowCall ? "mcp_fixture_slow" : "mcp_fixture_echo", arguments: "{}",
                } }] };
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: answered ? "stop" : "tool_calls" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let client: AttachedAgentClient | undefined;
    const workerPids = new Set<number>();
    let serverPid: number | undefined;
    try {
        host = await startResidentHost({
            home, skipStartupDiscovery: true,
            ...(pool ? { processWorker: true, processWorkerCount: 3 } : {}),
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
                extensions: [
                    { path: MCP, enabled: true, config: { servers: {
                        fixture: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: home } },
                    } } },
                    { path: local, enabled: true, config: {} },
                ],
            },
        });
        const events = (): string[] => readFileSync(join(home, "processes.log"), "utf8").trim().split("\n");
        const starts = events().filter((line) => line.startsWith("start "));
        expect(starts).toHaveLength(1);
        serverPid = Number(starts[0]!.slice(6));
        const owners: string[] = [];
        const outputs: string[] = [];
        const count = pool ? 3 : 1;
        for (let index = 0; index < count; index += 1) {
            const agent = await createAgentThroughHost(host.server.socketPath, home);
            const socket = agent.location?.socket_path ?? host.server.socketPath;
            const owner = agent.location?.worker_id ?? "host";
            const workerPid = (await requestHostIdentity(socket))!.pid;
            if (pool) workerPids.add(workerPid);
            owners.push(owner);
            client = await attachAgent({ socketPath: host.server.socketPath, agentId: agent.id });
            expect((await client.receive()).type).toBe("history");
            const commands = await client.listExtensionCommands!();
            expect(commands.map((command) => command.name)).toContain("local-pid");
            expect(commands.map((command) => command.name)).toContain("mcp-fixture-greet");
            expect((await client.runExtensionCommand!("local-pid", "")).body).toEqual({ kind: "text", text: String(workerPid) });
            if (index === 0) {
                expect((await client.runExtensionCommand!("mcp-fixture-greet", "")).body)
                    .toEqual({ kind: "text", text: String(serverPid) });
            }
            await client.send({ type: "prompt", content: `crow mcp ${index}` });
            outputs.push(await finishTurn(client, "mcp_fixture_echo"));
            if (pool && index === 0) {
                await client.send({ type: "prompt", content: "crow local" });
                outputs.push(await finishTurn(client, "local_probe"));
                await client.send({ type: "prompt", content: "crow slow" });
                const pending = finishTurn(client, "mcp_fixture_slow");
                await waitFor(() => events().some((line) => line.startsWith("slow ")));
                await client.send({ type: "abort" });
                await pending;
                await waitFor(() => events().some((line) => line.startsWith("cancel ")));
            }
            client.close();
            client = undefined;
        }
        expect(events().filter((line) => line.startsWith("start "))).toHaveLength(1);
        expect(events().filter((line) => line.startsWith("prompt "))).toHaveLength(1);
        console.log(JSON.stringify({ pool, outputs, events: events(), requests: requests.length }));
        expect(events().filter((line) => line.startsWith("call "))).toHaveLength(count);
        if (pool) {
            expect(events().filter((line) => line.startsWith("slow "))).toHaveLength(1);
            expect(events().filter((line) => line.startsWith("cancel "))).toHaveLength(1);
        }
        expect(requests[0]?.tools).toBeDefined();
        expect(requests.every((request) => JSON.stringify(request.tools) === JSON.stringify(requests[0]!.tools))).toBe(true);
        if (pool) expect(new Set(owners).size).toBe(3);
        return { tools: requests[0]!.tools!, owners, workerPids: [...workerPids], serverPid, outputs };
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        const started = [...workerPids, ...(serverPid === undefined ? [] : [serverPid]), ...(annexPid === undefined ? [] : [annexPid])];
        console.log(JSON.stringify({ pool, stopped: started.filter((pid) => !running(pid)), stillLive: started.filter(running) }));
        expect(started.filter(running)).toEqual([]);
        await rm(home, { recursive: true, force: true });
    }
}

async function finishTurn(client: AttachedAgentClient, tool: string): Promise<string> {
    let output = "";
    const updates: string[] = [];
    while (true) {
        const update = await client.receive(AbortSignal.timeout(15_000));
        updates.push(update.type);
        if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
            await client.send({ type: "ui_response", requestId: update.requestId,
                response: { type: "tool_approval", decision: "allow_once" } });
        }
        if (update.type === "tool_finished" && update.tool === tool) output = update.output ?? "";
        if (update.type === "turn_finished") {
            if (output.length === 0) console.log(JSON.stringify({ tool, updates, finished: update }));
            return output;
        }
    }
}

function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP fixture");
        await Bun.sleep(10);
    }
}

socketAndLoopbackTest("three workers share host MCP tools and commands with the single-host tool list", async () => {
    const single = await runCase(false);
    const pool = await runCase(true);
    expect(JSON.stringify(pool.tools)).toBe(JSON.stringify(single.tools));
    expect(pool.outputs).toEqual([
        String(pool.serverPid), String(pool.workerPids[0]), String(pool.serverPid), String(pool.serverPid),
    ]);
}, 60_000);
