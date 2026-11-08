import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { CRASHED_TOOL_RESULT, CRASH_CUT_MESSAGE, SessionStore, readSessionTurnState } from "../../src/store/session-store.ts";

interface StartedHost {
    readonly process: ReturnType<typeof Bun.spawn>;
    readonly stderr: Promise<string>;
    readonly annexPid?: number;
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(20);
    }
}

async function startHost(root: string, home: string, batch = false): Promise<StartedHost> {
    const ready = join(root, "ready.json");
    await rm(ready, { force: true });
    const child = Bun.spawn([process.execPath, "test/host/fixtures/crash-host.ts"], {
        cwd: process.cwd(),
        env: {
            ...process.env, HOME: home, VERA_HOME: home,
            VERA_DEV_INSTANCE: `${basename(process.cwd())} dev`, VERA_WORKER_EXTENSIONS: "1",
            VERA_CRASH_TEST_ROOT: root, ...(batch ? { VERA_CRASH_TEST_BATCH: "1" } : {}),
        },
        stdout: "ignore",
        stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    try {
        await waitFor(() => existsSync(ready) || child.exitCode !== null, "host startup");
        if (!existsSync(ready)) throw new Error(`Host exited: ${await stderr}`);
        const info = JSON.parse(await readFile(ready, "utf8")) as { pid: number; annexPid?: number };
        expect(info.pid).toBe(child.pid);
        return { process: child, stderr, ...(info.annexPid === undefined ? {} : { annexPid: info.annexPid }) };
    } catch (error) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        throw error;
    }
}

async function stopHost(host: StartedHost): Promise<void> {
    if (host.process.exitCode === null) host.process.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
        host.process.exited.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!finished) host.process.kill("SIGKILL");
    await host.process.exited;
    await host.stderr;
    await stopOwned(host.annexPid, "annex cleanup");
}

async function stopOwned(pid: number | undefined, label: string): Promise<void> {
    if (pid === undefined) return;
    if (alive(pid)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
    }
    await waitFor(() => !alive(pid), label);
}

test("a killed host repairs a blocked call before the next provider request", async () => {
    const root = await mkdtemp("/tmp/vera-dev/crash1-kill.");
    const home = join(root, "home");
    const socket = join(root, "host.sock");
    const toolPidPath = join(root, "tool.pid");
    const requests: Record<string, unknown>[] = [];
    const command = `echo $$ > '${toolPidPath}'; exec sleep 60`;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (request.method === "GET") return Response.json({ data: [{ id: "stub-model" }] });
            if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests.push(await request.json() as Record<string, unknown>);
            const delta = requests.length === 1
                ? { role: "assistant", tool_calls: [{ index: 0, id: "call-sleep", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }
                : { role: "assistant", content: "The crow checks the deck." };
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model", choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
    });
    let first: StartedHost | undefined;
    let second: StartedHost | undefined;
    let client: AttachedAgentClient | undefined;
    let toolPid: number | undefined;
    let workerPid: number | undefined;
    let supervisorPid: number | undefined;
    try {
        await mkdir(home, { recursive: true });
        await writeFile(join(home, "config.json"), JSON.stringify({
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        }));
        first = await startHost(root, home);
        const agent = await createAgentThroughHost(socket, root);
        client = await attachAgent({ socketPath: socket, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Inspect the deck." });
        while (true) {
            const update = await client.receive(AbortSignal.timeout(20_000));
            if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                await client.send({ type: "ui_response", requestId: update.requestId, response: { type: "tool_approval", decision: "allow_once" } });
                break;
            }
        }
        await waitFor(() => existsSync(toolPidPath), "blocked tool");
        toolPid = Number((await readFile(toolPidPath, "utf8")).trim());
        const running = (await listAgentsThroughHost(socket)).find((item) => item.id === agent.id);
        workerPid = running?.worker_pid;
        supervisorPid = running?.supervisor_pid;
        expect(alive(toolPid)).toBe(true);
        const sessionPath = join(root, "sessions", `${agent.id}.jsonl`);
        expect((await readSessionTurnState(sessionPath)).turnOpen).toBe(true);

        await client.send({ type: "prompt", content: "Secure the sails." });
        await client.send({ type: "prompt", content: "Check the compass." });
        const queued = await SessionStore.open(sessionPath);
        expect(queued.queuedPrompts().map((prompt) => prompt.content)).toEqual([
            "Secure the sails.", "Check the compass.",
        ]);
        const requestsBeforeCrash = requests.length;

        first.process.kill("SIGKILL");
        await first.process.exited;
        client.close();
        client = undefined;
        if (workerPid === undefined && alive(toolPid)) process.kill(toolPid, "SIGKILL");
        await waitFor(() => !alive(toolPid!), "tool exit");
        if (workerPid !== undefined) await waitFor(() => !alive(workerPid!), "worker exit");
        if (supervisorPid !== undefined) await waitFor(() => !alive(supervisorPid!), "supervisor exit");
        if (first.annexPid !== undefined) await waitFor(() => !alive(first!.annexPid!), "annex exit");

        second = await startHost(root, home);
        await resumeAgentThroughHost(socket, sessionPath);
        const repaired = await SessionStore.open(sessionPath);
        expect(repaired.messages().at(-1)).toMatchObject({
            role: "tool_result", toolCallId: "call-sleep", isError: true,
            content: [{ type: "text", text: CRASHED_TOOL_RESULT }],
        });
        expect((await readSessionTurnState(sessionPath)).turnOpen).toBe(false);
        const saved = await readFile(sessionPath, "utf8");
        expect(saved).toContain(CRASH_CUT_MESSAGE);
        client = await attachAgent({ socketPath: socket, agentId: agent.id });
        let history = await client.receive(AbortSignal.timeout(20_000));
        while (history.type !== "history" || history.unsentPrompts === undefined) {
            history = await client.receive(AbortSignal.timeout(20_000));
        }
        expect(history).toMatchObject({
            type: "history",
            unsentPrompts: [{ content: "Secure the sails." }, { content: "Check the compass." }],
        });
        await Bun.sleep(200);
        expect(requests).toHaveLength(requestsBeforeCrash);
        await client.send({ type: "prompt", content: "What is on the deck?" });
        while ((await client.receive(AbortSignal.timeout(20_000))).type !== "turn_finished") {}
        let nextHistory = await client.receive(AbortSignal.timeout(20_000));
        while (nextHistory.type !== "history") nextHistory = await client.receive(AbortSignal.timeout(20_000));
        expect(nextHistory.unsentPrompts).toBeUndefined();
        expect(requests.length).toBeGreaterThanOrEqual(2);
        const messages = requests.at(-1)!.messages as Array<Record<string, unknown>>;
        const calls = messages.flatMap((message) => (message.tool_calls as Array<{ id: string }> | undefined) ?? []);
        const results = messages.filter((message) => message.role === "tool");
        expect(calls.map((call) => call.id)).toContain("call-sleep");
        for (const call of calls) expect(results.filter((result) => result.tool_call_id === call.id)).toHaveLength(1);
        expect(results.find((result) => result.tool_call_id === "call-sleep")?.content).toBe(CRASHED_TOOL_RESULT);
        expect(JSON.stringify(messages)).not.toContain(CRASH_CUT_MESSAGE);
        expect(JSON.stringify(messages)).not.toContain("crashCut");
    } finally {
        client?.close();
        if (second !== undefined) await stopHost(second);
        if (first !== undefined) await stopHost(first);
        await stopOwned(toolPid, "tool cleanup");
        await stopOwned(workerPid, "worker cleanup");
        await stopOwned(supervisorPid, "supervisor cleanup");
        stub.stop(true);
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);

test("a killed host keeps a finished result from a parallel batch", async () => {
    const root = await mkdtemp("/tmp/vera-dev/crash2-batch.");
    const home = join(root, "home");
    const extension = join(home, "extensions", "batch");
    const socket = join(root, "host.sock");
    const requests: Record<string, unknown>[] = [];
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (request.method === "GET") return Response.json({ data: [{ id: "stub-model" }] });
            if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests.push(await request.json() as Record<string, unknown>);
            const delta = requests.length === 1
                ? { role: "assistant", tool_calls: [
                    { index: 0, id: "call-fast", type: "function", function: { name: "batch_probe", arguments: JSON.stringify({ speed: "fast" }) } },
                    { index: 1, id: "call-slow", type: "function", function: { name: "batch_probe", arguments: JSON.stringify({ speed: "slow" }) } },
                ] }
                : { role: "assistant", content: "The crow checks the deck." };
            const chunk = { id: "stub", object: "chat.completion.chunk", model: "stub-model", choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
    });
    let first: StartedHost | undefined;
    let second: StartedHost | undefined;
    let client: AttachedAgentClient | undefined;
    let workerPid: number | undefined;
    let supervisorPid: number | undefined;
    try {
        await mkdir(extension, { recursive: true });
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id: "test.batch", version: "1.0.0", sdk: "1", entrypoint: "./extension.ts",
            capabilities: ["tools.register"],
        }));
        await writeFile(join(extension, "extension.ts"), `
            export function activate(vera) {
                vera.tools.register({
                    name: "batch_probe", description: "Inspect the ship", parallel: true,
                    inputSchema: { type: "object", properties: { speed: { type: "string" } }, required: ["speed"], additionalProperties: false },
                    async run({ input }) {
                        if (input.speed === "slow") {
                            await Bun.write(${JSON.stringify(join(root, "slow-started"))}, "started");
                            await new Promise(() => {});
                        }
                        return { output: "The deck is clear." };
                    },
                });
            }
        `);
        await writeFile(join(home, "config.json"), JSON.stringify({
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "ask",
            providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            extensions: [{ path: extension, enabled: true, config: null }],
        }));
        first = await startHost(root, home, true);
        const agent = await createAgentThroughHost(socket, root);
        client = await attachAgent({ socketPath: socket, agentId: agent.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Inspect the ship." });
        let approvals = 0;
        while (approvals < 2) {
            const update = await client.receive(AbortSignal.timeout(20_000));
            if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                await client.send({ type: "ui_response", requestId: update.requestId, response: { type: "tool_approval", decision: "allow_once" } });
                approvals += 1;
            }
        }
        await waitFor(() => existsSync(join(root, "slow-started")), "slow call");
        await waitFor(() => existsSync(join(root, "fast-durable")), "durable fast call");
        await client.send({ type: "prompt", content: "Secure the sails." });
        await client.send({ type: "prompt", content: "Check the compass." });
        expect(requests).toHaveLength(1);
        const sessionPath = join(root, "sessions", `${agent.id}.jsonl`);
        expect((await SessionStore.open(sessionPath)).queuedPrompts().map((prompt) => prompt.content)).toEqual([
            "Secure the sails.", "Check the compass.",
        ]);
        const running = (await listAgentsThroughHost(socket)).find((item) => item.id === agent.id);
        workerPid = running?.worker_pid;
        supervisorPid = running?.supervisor_pid;

        first.process.kill("SIGKILL");
        await first.process.exited;
        client.close();
        client = undefined;
        if (workerPid !== undefined) await waitFor(() => !alive(workerPid!), "worker exit");
        if (supervisorPid !== undefined) await waitFor(() => !alive(supervisorPid!), "supervisor exit");
        if (first.annexPid !== undefined) await waitFor(() => !alive(first!.annexPid!), "annex exit");

        second = await startHost(root, home);
        await resumeAgentThroughHost(socket, sessionPath);
        const repaired = await SessionStore.open(sessionPath);
        const results = repaired.messages().filter((message) => message.role === "tool_result");
        expect(results).toMatchObject([
            { toolCallId: "call-fast", isError: false, content: [{ type: "text", text: "The deck is clear." }] },
            { toolCallId: "call-slow", isError: true, content: [{ type: "text", text: CRASHED_TOOL_RESULT }] },
        ]);
        expect((await readSessionTurnState(sessionPath)).turnOpen).toBe(false);
        const records = (await readFile(sessionPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
        expect(records.at(-1)).toMatchObject({
            type: "harness_message", text: CRASH_CUT_MESSAGE, crashCut: true,
            unsentPrompts: [{ content: "Secure the sails." }, { content: "Check the compass." }],
        });
        client = await attachAgent({ socketPath: socket, agentId: agent.id });
        let history = await client.receive(AbortSignal.timeout(20_000));
        while (history.type !== "history" || history.unsentPrompts === undefined) {
            history = await client.receive(AbortSignal.timeout(20_000));
        }
        expect(history).toMatchObject({
            type: "history",
            unsentPrompts: [{ content: "Secure the sails." }, { content: "Check the compass." }],
        });
        await Bun.sleep(200);
        expect(requests).toHaveLength(1);
        await client.send({ type: "prompt", content: "What is on the deck?" });
        while ((await client.receive(AbortSignal.timeout(20_000))).type !== "turn_finished") {}
        let nextHistory = await client.receive(AbortSignal.timeout(20_000));
        while (nextHistory.type !== "history") nextHistory = await client.receive(AbortSignal.timeout(20_000));
        expect(nextHistory.unsentPrompts).toBeUndefined();
        const messages = requests.at(-1)!.messages as Array<Record<string, unknown>>;
        const sent = messages.filter((message) => message.role === "tool");
        expect(sent.find((result) => result.tool_call_id === "call-fast")?.content).toBe("The deck is clear.");
        expect(sent.find((result) => result.tool_call_id === "call-slow")?.content).toBe(CRASHED_TOOL_RESULT);
        expect(sent).toHaveLength(2);
    } finally {
        client?.close();
        if (second !== undefined) await stopHost(second);
        if (first !== undefined) await stopHost(first);
        await stopOwned(workerPid, "worker cleanup");
        await stopOwned(supervisorPid, "supervisor cleanup");
        stub.stop(true);
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
