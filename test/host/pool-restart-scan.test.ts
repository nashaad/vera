import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { inProcessWorkerSocket } from "../../src/host/master/in-process.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { defaultRestartRecordPath, listRestartRecords } from "../../src/store/restart-records.ts";
import { CRASH_CUT_MESSAGE, SessionStore } from "../../src/store/session-store.ts";

interface PoolHostInfo {
    readonly pid: number;
    readonly workerPid: number;
    readonly annexPid?: number;
    readonly socket: string;
}

test("restart scan repairs a killed worker's turn and queued prompt", async () => {
    const root = await mkdtemp("/private/tmp/vera-dev/hs4-scan-");
    const home = join(root, "home");
    await mkdir(home);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = true;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            if (hold) { started.resolve(); await release.promise; }
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The deck is clear."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-crash-host.ts"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    let info: PoolHostInfo | undefined;
    let client: AttachedAgentClient | undefined;
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let newWorkerPid: number | undefined;
    const owned = new Map<number, { startedAt: number; command: string }>();
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolHostInfo;
        expect(info.pid).toBe(child.pid);
        expect(info.workerPid).not.toBe(info.pid);
        rememberProcess(owned, info.workerPid);
        if (info.annexPid !== undefined) rememberProcess(owned, info.annexPid);
        const session = await createAgentThroughHost(info.socket, home);
        const path = join(home, "runtime", "sessions", `${session.id}.jsonl`);
        client = await attachAgent({ socketPath: info.socket, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Inspect the deck." });
        await within(started.promise);
        await client.send({ type: "prompt", content: "Check the sails." });
        expect((await SessionStore.open(path)).queuedPrompts()).toMatchObject([{ content: "Check the sails." }]);

        stopOwnedProcess(owned, info.workerPid);
        await waitFor(() => !alive(info!.workerPid), "worker exit");
        await waitFor(() => client!.closed, "client disconnect");
        client.close();
        client = undefined;
        child.kill("SIGKILL");
        await child.exited;
        await waitFor(() => !alive(child.pid), "master exit");
        hold = false;
        release.resolve();

        host = await startResidentHost({ home, config, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true });
        const recovered = await SessionStore.open(path);
        expect(recovered.unsentPrompts()).toEqual([{ content: "Inspect the deck." }, { content: "Check the sails." }]);
        expect((await readFile(path, "utf8")).split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        expect(listRestartRecords(defaultRestartRecordPath(home))).toContainEqual(expect.objectContaining({
            session_id: session.id, cause: "crash",
        }));
        expect((await resumeAgentThroughHost(host.server.socketPath, path)).id).toBe(session.id);
        const workerIdentity = await requestHostIdentity(inProcessWorkerSocket(home));
        newWorkerPid = workerIdentity!.pid;
        rememberProcess(owned, newWorkerPid);
        if (host.annexPid !== undefined) rememberProcess(owned, host.annexPid);
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
        expect(await client.receive()).toMatchObject({
            type: "history", unsentPrompts: [{ content: "Inspect the deck." }, { content: "Check the sails." }],
        });
        await client.send({ type: "prompt", content: "Continue the voyage." });
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        await client.detach();
        client.close();
        client = await attachAgent({ socketPath: host.server.socketPath, agentId: session.id });
        const history = await client.receive();
        expect(history.type).toBe("history");
        if (history.type !== "history") throw new Error("Missing history");
        expect(history.unsentPrompts).toBeUndefined();
    } finally {
        release.resolve();
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        await stderr;
        for (const pid of [info?.workerPid, info?.annexPid, newWorkerPid, annexPid]) {
            if (pid === undefined) continue;
            if (alive(pid)) stopOwnedProcess(owned, pid);
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        stub.stop(true);
        await rm(root, { recursive: true, force: true });
    }
}, 40_000);

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

function rememberProcess(owned: Map<number, { startedAt: number; command: string }>, pid: number): void {
    const startedAt = processStartedAt(pid);
    const command = processCommandLine(pid);
    if (startedAt === undefined || command === undefined) throw new Error(`Could not inspect process ${pid}`);
    owned.set(pid, { startedAt, command });
}

function stopOwnedProcess(owned: Map<number, { startedAt: number; command: string }>, pid: number): void {
    const recorded = owned.get(pid);
    const startedAt = processStartedAt(pid);
    const command = processCommandLine(pid);
    if (recorded === undefined || startedAt === undefined || Math.abs(startedAt - recorded.startedAt) > 2_000
        || command !== recorded.command) throw new Error(`Process ${pid} no longer matches the started process`);
    process.kill(pid, "SIGKILL");
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(10);
    }
}

async function within(promise: Promise<void>): Promise<void> {
    await Promise.race([promise, Bun.sleep(10_000).then(() => { throw new Error("Timed out waiting for the provider"); })]);
}
