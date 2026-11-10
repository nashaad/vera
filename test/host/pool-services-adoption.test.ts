import { expect, spyOn } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as configModule from "../../src/config.ts";
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import * as credentials from "../../src/host/pool/credentials.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { createAuthStorage, defaultAuthStoragePath } from "../../src/providers/auth-storage.ts";

const MCP = fileURLToPath(new URL("../../extensions/mcp", import.meta.url));
const SERVER = fileURLToPath(new URL("../extensions/fixtures/mcp-reconnect-server.ts", import.meta.url));

interface PoolInfo {
    readonly pid: number;
    readonly workers: readonly number[];
    readonly annexPid?: number;
    readonly socket: string;
}

socketAndLoopbackTest("an adopted worker uses the new host's MCP server, credential broker and settings writer", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-services-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const key = randomUUID();
    createAuthStorage({ path: defaultAuthStoragePath(home) }).setCredential("stub", { type: "api_key", key });
    let requests = 0;
    let headersCorrect = true;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests += 1;
            headersCorrect &&= request.headers.get("authorization") === `Bearer ${key}`;
            const body = await request.json() as { messages?: Array<{ role?: string }> };
            const lastUser = body.messages?.findLastIndex((message) => message.role === "user") ?? -1;
            const answered = body.messages?.slice(lastUser + 1).some((message) => message.role === "tool") === true;
            const delta = answered ? { role: "assistant", content: "The crow received the result." }
                : { role: "assistant", tool_calls: [{ index: 0, id: "call-mcp", type: "function", function: {
                    name: "mcp_fixture_echo", arguments: "{}",
                } }] };
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model",
                choices: [{ index: 0, delta, finish_reason: answered ? "stop" : "tool_calls" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } });
        },
    });
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "api_key" } },
        extensions: [{ path: MCP, enabled: true, config: { servers: {
            fixture: { command: [process.execPath, SERVER], env: { MCP_RECONNECT_FIXTURE: home, MCP_RECONNECT_LIFETIME_MS: "60000" } },
        } } }],
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "20000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, { startedAt: number; command: string }>();
    let info: PoolInfo | undefined;
    let host: ResidentHost | undefined;
    let client: AttachedAgentClient | undefined;
    let leases = 0;
    const writers: number[] = [];
    const createBroker = credentials.createCredentialBroker;
    const brokerSpy = spyOn(credentials, "createCredentialBroker").mockImplementation((options) => {
        const broker = createBroker(options);
        return { ...broker, async lease(provider, rejected) { leases += 1; return await broker.lease(provider, rejected); } };
    });
    const updateConfig = configModule.updateVeraConfigDefaults;
    const writerSpy = spyOn(configModule, "updateVeraConfigDefaults").mockImplementation((patch, options) => {
        writers.push(process.pid);
        return updateConfig(patch, options);
    });
    const events = (): string[] => existsSync(join(home, "processes.log"))
        ? readFileSync(join(home, "processes.log"), "utf8").trim().split("\n") : [];
    const servers = (): number[] => events().filter((event) => event.startsWith("start ")).map((event) => Number(event.slice(6)));
    const remember = (pid: number): void => {
        const startedAt = processStartedAt(pid);
        const command = processCommandLine(pid);
        if (startedAt === undefined || command === undefined) throw new Error(`Could not inspect process ${pid}`);
        started.set(pid, { startedAt, command });
    };
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        expect(servers()).toHaveLength(1);
        for (const pid of [...info.workers, ...servers(), ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(pid);
        const session = await createAgentThroughHost(info.socket, home);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        child.kill("SIGKILL");
        await child.exited;
        await waitFor(() => !alive(servers()[0]!), "old MCP server exit");
        host = await startResidentHost({ home, config, webRoot, skipStartupDiscovery: true });
        expect((await requestHostIdentity(session.location!.socket_path))?.pid).toBe(info.workers[0]);
        expect(servers()).toHaveLength(2);
        const serverPid = servers()[1]!;
        remember(serverPid);
        expect(servers().filter(alive)).toEqual([serverPid]);
        await client.send({ type: "update_model_settings", requestId: "save", patch: { contextLimit: 42_000 } });
        while (true) {
            const update = await client.receive(AbortSignal.timeout(10_000));
            if (update.type === "model_settings" && update.requestId === "save") break;
        }
        expect(writers).toEqual([process.pid]);
        expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).context_limit).toBe(42_000);
        await client.send({ type: "prompt", content: "Check the map." });
        let output = "";
        while (true) {
            const update = await client.receive(AbortSignal.timeout(15_000));
            if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                await client.send({ type: "ui_response", requestId: update.requestId,
                    response: { type: "tool_approval", decision: "allow_once" } });
            }
            if (update.type === "tool_finished" && update.tool === "mcp_fixture_echo") output = update.output ?? "";
            if (update.type === "turn_finished") break;
        }
        expect(output).toBe(String(serverPid));
        expect(events().filter((event) => event.startsWith("call "))).toEqual([`call ${serverPid}`]);
        expect(headersCorrect).toBe(true);
        expect(leases).toBeGreaterThan(0);
        expect(requests).toBe(2);
    } finally {
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await child.exited;
        for (const [pid, recorded] of started) {
            if (alive(pid)) {
                const startedAt = processStartedAt(pid);
                if (startedAt === undefined || Math.abs(startedAt - recorded.startedAt) > 2_000
                    || processCommandLine(pid) !== recorded.command) throw new Error(`Process ${pid} no longer matches`);
                try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        stub.stop(true);
        brokerSpy.mockRestore();
        writerSpy.mockRestore();
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 50_000);

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(10);
    }
}
