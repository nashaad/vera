import { expect, spyOn } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { projectTranscript } from "../../src/engine/protocol.ts";
import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { connectHost } from "../../src/host/connection.ts";
import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import * as supervisor from "../../src/host/pool/supervisor.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { CRASH_CUT_MESSAGE, readSessionTurnState, SessionStore, WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";

interface PoolInfo {
    readonly pid: number;
    readonly workers: readonly number[];
    readonly annexPid?: number;
    readonly socket: string;
}

interface StartedProcess {
    readonly startedAt: number;
    readonly command: string;
}

async function fixture(graceMs: number, count = 1, queuePrompts = false, failDispose = false) {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-grace-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const extension = join(home, "extension");
    if (failDispose) {
        await mkdir(extension);
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id: "test.cleanup", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: [],
        }));
        await writeFile(join(extension, "extension.ts"),
            'export function activate(vera) { vera.onDispose(() => { throw new Error("cleanup failed"); }); }\n');
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            requests += 1;
            if (requests === count) entered.resolve();
            await release.promise;
            return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
        },
    });
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
        ...(failDispose ? { extensions: [{ path: extension, enabled: true, config: {} }] } : {}),
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", String(count), String(graceMs)], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    const notices: string[] = [];
    let info: PoolInfo | undefined;
    const clients: AttachedAgentClient[] = [];
    let host: ResidentHost | undefined;
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(started, pid);
        const sessions = [];
        for (let index = 0; index < count; index += 1) {
            const session = await createAgentThroughHost(info.socket, home);
            sessions.push(session);
            const client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "Inspect the map." });
        }
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Provider did not start"); })]);
        const paths = sessions.map((session) => join(home, "runtime", "sessions", `${session.id}.jsonl`));
        for (const path of paths) expect((await readSessionTurnState(path)).turnOpen).toBe(true);
        if (queuePrompts) {
            for (const attached of clients) await attached.send({ type: "prompt", content: "Check the sails." });
            const deadline = Date.now() + 10_000;
            for (const path of paths) {
                while (!(await readFile(path, "utf8")).includes('"type":"queued_prompt"')) {
                    if (Date.now() >= deadline) throw new Error("Queued prompt was not recorded");
                    await Bun.sleep(10);
                }
            }
        }
        const session = sessions[0]!;
        const path = paths[0]!;
        const client = clients[0]!;
        const worker = info.workers[0]!;
        return {
            home, webRoot, config, info, session, sessions, path, worker, client, clients, paths, notices,
            async killHost() {
                child.kill("SIGKILL");
                await child.exited;
                await waitFor(() => !alive(child.pid), "host exit");
            },
            freeze() { signalStarted(started, worker, "SIGSTOP"); },
            async startHost(configuredCount?: number) {
                host = await startResidentHost({ home, config, webRoot, skipStartupDiscovery: true, processWorkerHeartbeatDeadlineMs: 500,
                    ...(configuredCount === undefined ? {} : { processWorkerCount: configuredCount }),
                    startupLog: (entry) => { if (typeof entry.message === "string") notices.push(entry.message); } });
                const replacement = await requestHostIdentity(inProcessWorkerSocket(home));
                if (replacement !== undefined && !started.has(replacement.pid)) remember(started, replacement.pid);
                return host;
            },
            async close() {
                release.resolve();
                for (const attached of clients) attached.close();
                const annexPid = host?.annexPid;
                await host?.close();
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
                await child.exited;
                for (const pid of started.keys()) {
                    if (alive(pid)) signalStarted(started, pid, "SIGKILL");
                    await waitFor(() => !alive(pid), `process ${pid} exit`);
                }
                if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
                stub.stop(true);
                await stderr;
                await rm(home, { recursive: true, force: true });
            },
        };
    } catch (error) {
        release.resolve();
        for (const attached of clients) attached.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const pid of started.keys()) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        stub.stop(true);
        await stderr;
        await rm(home, { recursive: true, force: true });
        throw error;
    }
}

socketAndLoopbackTest("responsive workers record their cut turns once and exit without a host", async () => {
    const harness = await fixture(800, 2, true);
    try {
        await harness.killHost();
        for (const [index, worker] of harness.info.workers.entries()) {
            await waitFor(() => !alive(worker), "worker exit");
            const path = harness.paths[index]!;
            const log = await readFile(path, "utf8");
            expect(log.split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
            expect((await readSessionTurnState(path)).turnOpen).toBe(false);
            const store = await SessionStore.open(path);
            expect(store.unsentPrompts().map((prompt) => prompt.content)).toEqual(["Inspect the map.", "Check the sails."]);
            expect(store.queuedPrompts()).toEqual([]);
            expect(projectTranscript(store.messages())).toContainEqual({
                kind: "error", outcome: "error", detail: WORKER_EXIT_TURN_MESSAGE,
            });
            expect(existsSync(join(harness.home, "runtime", "workers", `w${index}.json`))).toBe(false);
            const attached = harness.clients[index]!;
            await waitFor(() => attached.closed, "client close");
            let closeError: unknown;
            try {
                while (true) await attached.receive(AbortSignal.timeout(2_000));
            } catch (error) { closeError = error; }
            expect(closeError).toMatchObject({ name: "HostConnectionClosedError", message: "host connection closed" });
        }
    } finally { await harness.close(); }
}, 30_000);

socketAndLoopbackTest("an orphan records its failed turn even if extension cleanup fails", async () => {
    const harness = await fixture(800, 1, true, true);
    try {
        await harness.killHost();
        await waitFor(() => !alive(harness.worker), "worker exit");
        const log = await readFile(harness.path, "utf8");
        expect(log.split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
        const store = await SessionStore.open(harness.path);
        expect(store.unsentPrompts().map((prompt) => prompt.content)).toEqual(["Inspect the map.", "Check the sails."]);
        expect(existsSync(join(harness.home, "runtime", "workers", "w0.json"))).toBe(false);
        await waitFor(() => harness.client.closed, "client close");
    } finally { await harness.close(); }
}, 30_000);

socketAndLoopbackTest("a new host replaces a silent worker and records its cut turn once", async () => {
    const harness = await fixture(15_000, 2);
    try {
        harness.freeze();
        await waitFor(() => stopped(harness.worker), "worker to stop");
        await harness.killHost();
        const host = await harness.startHost();
        expect(alive(harness.worker)).toBe(false);
        expect(harness.notices).toContain(`Session process PID ${harness.worker} is not answering.`);
        const identity = await requestHostIdentity(inProcessWorkerSocket(harness.home));
        expect(identity?.pid).not.toBe(harness.worker);
        const log = await readFile(harness.path, "utf8");
        expect(log.split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
        expect(log).not.toContain(CRASH_CUT_MESSAGE);
        expect((await readSessionTurnState(harness.path)).turnOpen).toBe(false);
        const survivor = await requestHostIdentity(inProcessWorkerSocket(harness.home, 1));
        if (survivor === undefined) {
            const detail = await readFile(harness.paths[1]!, "utf8");
            console.info(JSON.stringify({ pid: harness.info.workers[1], alive: alive(harness.info.workers[1]!),
                workers: host.health.workers, failedTurnRecorded: detail.includes(WORKER_EXIT_TURN_MESSAGE),
                crashRecorded: detail.includes(CRASH_CUT_MESSAGE) }));
        }
        expect(survivor?.pid).toBe(harness.info.workers[1]);
        const survivorLog = await readFile(harness.paths[1]!, "utf8");
        expect(survivorLog).not.toContain(WORKER_EXIT_TURN_MESSAGE);
        expect(survivorLog).not.toContain(CRASH_CUT_MESSAGE);
        expect((await readSessionTurnState(harness.paths[1]!)).turnOpen).toBe(true);
        expect((await resumeAgentThroughHost(host.server.socketPath, harness.path)).id).toBe(harness.session.id);
    } finally { await harness.close(); }
}, 30_000);

socketAndLoopbackTest("recovery does not write a session held by an answering worker with a missing record", async () => {
    const harness = await fixture(15_000, 2);
    try {
        harness.freeze();
        await waitFor(() => stopped(harness.worker), "worker to stop");
        await harness.killHost();
        await unlink(join(harness.home, "runtime", "workers", "w1.json"));
        const host = await harness.startHost();
        const survivorPid = harness.info.workers[1]!;
        await waitForAsync(async () => {
            try {
                const record = JSON.parse(await readFile(join(harness.home, "runtime", "workers", "w1.json"), "utf8"));
                return record.pid === survivorPid && host.health.workers?.[1]?.state === "ready";
            } catch { return false; }
        }, "survivor adoption");
        await waitForAsync(async () => (await readFile(harness.paths[0]!, "utf8")).includes(WORKER_EXIT_TURN_MESSAGE),
            "recovery scan");
        const sessionLog = await readFile(harness.paths[1]!, "utf8");
        expect({
            survivorAlive: alive(survivorPid),
            survivorAnswering: (await requestHostIdentity(inProcessWorkerSocket(harness.home, 1)))?.pid === survivorPid,
            failedTurnRecorded: sessionLog.includes(WORKER_EXIT_TURN_MESSAGE),
            turnOpen: (await readSessionTurnState(harness.paths[1]!)).turnOpen,
        }).toEqual({
            survivorAlive: true,
            survivorAnswering: true,
            failedTurnRecorded: false,
            turnOpen: true,
        });
    } finally { await harness.close(); }
}, 30_000);

socketAndLoopbackTest("an unrecorded worker reconnects and is adopted with its resident session", async () => {
    const harness = await fixture(15_000, 2);
    try {
        await harness.killHost();
        await unlink(join(harness.home, "runtime", "workers", "w1.json"));
        const host = await harness.startHost();
        const pid = harness.info.workers[1]!;
        await waitForAsync(async () => {
            try {
                const record = JSON.parse(await readFile(join(harness.home, "runtime", "workers", "w1.json"), "utf8"));
                return record.pid === pid && record.host_pid === process.pid
                    && host.health.workers?.[1]?.state === "ready";
            } catch { return false; }
        }, "unrecorded worker adoption");
        expect((await requestHostIdentity(inProcessWorkerSocket(harness.home, 1)))?.pid).toBe(pid);
        expect(await locate(host.server.socketPath, harness.sessions[1]!.id)).toMatchObject({
            type: "agent_location", worker_id: "w1", socket_path: inProcessWorkerSocket(harness.home, 1),
        });
        expect((await readSessionTurnState(harness.paths[1]!)).turnOpen).toBe(true);
        expect(await readFile(harness.paths[1]!, "utf8")).not.toContain(WORKER_EXIT_TURN_MESSAGE);
    } finally { await harness.close(); }
}, 30_000);

socketAndLoopbackTest("an unrecorded worker that does not reconnect exits before recovery scans", async () => {
    const harness = await fixture(8_000, 3);
    const start = supervisor.startSessionWorkerSupervisor;
    const refuseReconnect = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) =>
        options.adopt?.unrecorded === true ? Promise.reject(new Error("Reconnect withheld")) : start(options));
    try {
        harness.freeze();
        await waitFor(() => stopped(harness.worker), "worker to stop");
        await harness.killHost();
        await unlink(join(harness.home, "runtime", "workers", "w1.json"));
        const host = await harness.startHost();
        const waitingPid = harness.info.workers[1]!;
        expect(alive(waitingPid)).toBe(true);
        expect(await readFile(harness.paths[0]!, "utf8")).not.toContain(WORKER_EXIT_TURN_MESSAGE);
        expect((await readSessionTurnState(harness.paths[1]!)).turnOpen).toBe(true);
        expect(await locate(host.server.socketPath, harness.sessions[1]!.id)).toMatchObject({
            type: "agent_location_failed", reason: "worker_unavailable", message: "The session process is unavailable.",
        });
        expect(await locate(host.server.socketPath, harness.sessions[2]!.id)).toMatchObject({
            type: "agent_location", worker_id: "w2",
        });
        await harness.clients[2]!.send({ type: "update_model_settings", requestId: "available", patch: { contextLimit: 42_000 } });
        while (true) {
            const update = await harness.clients[2]!.receive(AbortSignal.timeout(3_000));
            if (update.type === "model_settings" && update.requestId === "available") break;
        }
        expect((await createAgentThroughHost(host.server.socketPath, harness.home)).id).toBeDefined();
        await waitFor(() => !alive(waitingPid), "unrecorded worker exit");
        await waitForAsync(async () => {
            const worker = await requestHostIdentity(inProcessWorkerSocket(harness.home, 1));
            return worker !== undefined && worker.pid !== waitingPid;
        }, "unrecorded worker replacement");
        await waitForAsync(async () => (await readFile(harness.paths[0]!, "utf8")).includes(WORKER_EXIT_TURN_MESSAGE),
            "recovery scan");
        for (const path of harness.paths.slice(0, 2)) {
            expect((await readFile(path, "utf8")).split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
        }
        expect((await requestHostIdentity(inProcessWorkerSocket(harness.home, 2)))?.pid).toBe(harness.info.workers[2]);
        expect((await readSessionTurnState(harness.paths[2]!)).turnOpen).toBe(true);
    } finally {
        refuseReconnect.mockRestore();
        await harness.close();
    }
}, 35_000);

socketAndLoopbackTest("a pool without worker records takes its size from a control reconnect", async () => {
    const harness = await fixture(15_000, 2);
    try {
        await harness.killHost();
        for (let index = 0; index < 2; index += 1) {
            await unlink(join(harness.home, "runtime", "workers", `w${index}.json`));
        }
        const host = await harness.startHost();
        expect(host.health.workers).toHaveLength(2);
        await waitForAsync(async () => {
            const workers = host.health.workers ?? [];
            return workers.length === 2 && workers.every((worker, index) =>
                worker.pid === harness.info.workers[index] && worker.state === "ready");
        }, "workers to reconnect");
        for (const [index, pid] of harness.info.workers.entries()) {
            expect((await requestHostIdentity(inProcessWorkerSocket(harness.home, index)))?.pid).toBe(pid);
            expect((await readSessionTurnState(harness.paths[index]!)).turnOpen).toBe(true);
        }
    } finally { await harness.close(); }
}, 35_000);

socketAndLoopbackTest("a silent worker record without a count uses the configured pool size", async () => {
    const harness = await fixture(15_000);
    try {
        harness.freeze();
        await waitFor(() => stopped(harness.worker), "worker to stop");
        await harness.killHost();
        const path = join(harness.home, "runtime", "workers", "w0.json");
        const record = JSON.parse(await readFile(path, "utf8"));
        delete record.count;
        await writeFile(path, JSON.stringify(record));
        const host = await harness.startHost(1);
        expect(host.health.workers).toHaveLength(1);
        expect(alive(harness.worker)).toBe(false);
        expect((await requestHostIdentity(inProcessWorkerSocket(harness.home)))?.pid).not.toBe(harness.worker);
        expect((await readFile(harness.path, "utf8")).split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
    } finally { await harness.close(); }
}, 30_000);

socketAndLoopbackTest("recovery waits for an answering worker-shaped socket outside the pool", async () => {
    const harness = await fixture(15_000, 2);
    const extra = createServer((socket) => socket.end("{}\n"));
    try {
        harness.freeze();
        await waitFor(() => stopped(harness.worker), "worker to stop");
        await harness.killHost();
        await new Promise<void>((resolve, reject) => extra.once("error", reject)
            .listen(join(harness.home, "runtime", "w-held.sock"), resolve));
        const host = await harness.startHost();
        expect(await readFile(harness.paths[0]!, "utf8")).not.toContain(WORKER_EXIT_TURN_MESSAGE);
        expect(await locate(host.server.socketPath, harness.sessions[1]!.id)).toMatchObject({
            type: "agent_location", worker_id: "w1",
        });
        await new Promise<void>((resolve, reject) => extra.close((error) => error === undefined ? resolve() : reject(error)));
        await waitForAsync(async () => (await readFile(harness.paths[0]!, "utf8")).includes(WORKER_EXIT_TURN_MESSAGE),
            "recovery after the socket closed");
        expect((await readFile(harness.paths[0]!, "utf8")).split(WORKER_EXIT_TURN_MESSAGE)).toHaveLength(2);
        expect((await requestHostIdentity(inProcessWorkerSocket(harness.home, 1)))?.pid).toBe(harness.info.workers[1]);
        expect((await readSessionTurnState(harness.paths[1]!)).turnOpen).toBe(true);
    } finally {
        if (extra.listening) await new Promise<void>((resolve) => extra.close(() => resolve()));
        await harness.close();
    }
}, 35_000);

async function locate(socketPath: string, id: string): Promise<unknown> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "locate_agent", agent_id: id });
        return await connection.receive();
    } finally { connection.close(); }
}

function remember(started: Map<number, StartedProcess>, pid: number): void {
    const startedAt = processStartedAt(pid);
    const command = processCommandLine(pid);
    if (startedAt === undefined || command === undefined) throw new Error(`Could not inspect process ${pid}`);
    started.set(pid, { startedAt, command });
}

function signalStarted(started: Map<number, StartedProcess>, pid: number, signal: NodeJS.Signals): void {
    const recorded = started.get(pid);
    const startedAt = processStartedAt(pid);
    const command = processCommandLine(pid);
    if ((startedAt === undefined || command === undefined) && !alive(pid)) return;
    if (recorded === undefined || startedAt === undefined || Math.abs(startedAt - recorded.startedAt) > 2_000
        || command !== recorded.command) throw new Error(`Process ${pid} no longer matches the started process`);
    try { process.kill(pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

function stopped(pid: number): boolean {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="]);
    return result.exitCode === 0 && result.stdout.toString().trim().startsWith("T");
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(10);
    }
}

async function waitForAsync(predicate: () => Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!await predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(20);
    }
}
