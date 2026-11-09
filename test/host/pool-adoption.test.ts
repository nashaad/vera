import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../../clients/cli/main.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_STOP_WAIT } from "../../src/host/capabilities.ts";
import { connectHost } from "../../src/host/connection.ts";
import { inProcessWorkerSocket } from "../../src/host/master/in-process.ts";
import { ControlPeer } from "../../src/host/master/control.ts";
import * as supervisor from "../../src/host/master/supervisor.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { requestHostIdentity, requestHostStop } from "../../src/host/protocol.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { TURNS_HELD_REFUSAL } from "../../src/host/stop-when-idle.ts";
import * as store from "../../src/store/session-store.ts";

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

test("a new master adopts both workers and a running turn survives its death", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-adopt-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const adoptionEntered = Promise.withResolvers<void>();
    const adoptionRelease = Promise.withResolvers<void>();
    let calls = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            calls += 1;
            if (calls === 1) { entered.resolve(); await release.promise; }
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "2", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    const clients: AttachedAgentClient[] = [];
    let info: PoolInfo | undefined;
    let host: ResidentHost | undefined;
    let starting: Promise<ResidentHost> | undefined;
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        expect(info.pid).toBe(child.pid);
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(started, pid);
        const first = await createAgentThroughHost(info.socket, home);
        const second = await createAgentThroughHost(info.socket, home);
        expect(first.location?.worker_id).not.toBe(second.location?.worker_id);
        for (const session of [first, second]) {
            const client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
            clients.push(client);
            expect((await client.receive()).type).toBe("history");
        }
        await clients[0]!.send({ type: "prompt", content: "Inspect the map." });
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Provider did not start"); })]);
        child.kill("SIGKILL");
        await child.exited;
        await waitFor(() => !alive(child.pid), "master exit");
        release.resolve();
        while ((await clients[0]!.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        for (const pid of info.workers) expect(alive(pid)).toBe(true);
        await Promise.race([
            expect(createAgentThroughHost(first.location!.socket_path, home)).rejects.toThrow("host connection closed"),
            Bun.sleep(2_000).then(() => { throw new Error("Create did not fail during the master outage"); }),
        ]);
        await clients[0]!.send({ type: "update_model_settings", requestId: "during-gap", patch: { contextLimit: 42_000 } });
        while (true) {
            const update = await clients[0]!.receive(AbortSignal.timeout(2_000));
            if (update.type === "model_settings_rejected" && update.requestId === "during-gap") {
                expect(update.reason).toBe("unavailable");
                break;
            }
        }

        const directory = join(home, "runtime", "sessions");
        let scans = 0;
        let fileReads = 0;
        let fileOpens = 0;
        const readDirectory = fs.readdir;
        const readSessionFile = fs.readFile;
        const openSessionFile = fs.open;
        const reads = spyOn(store, "readSessionHeader");
        const snapshots = spyOn(store, "readSessionSnapshot");
        const directories = spyOn(fs, "readdir").mockImplementation((async (path: Parameters<typeof fs.readdir>[0], options?: unknown) => {
            if (String(path) === directory) scans += 1;
            return await (readDirectory as (...args: unknown[]) => Promise<unknown>)(path, options);
        }) as typeof fs.readdir);
        const files = spyOn(fs, "readFile").mockImplementation((async (path: Parameters<typeof fs.readFile>[0], options?: unknown) => {
            if (String(path).startsWith(`${directory}/`)) fileReads += 1;
            return await (readSessionFile as (...args: unknown[]) => Promise<unknown>)(path, options);
        }) as typeof fs.readFile);
        const opens = spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
            if (String(args[0]).startsWith(`${directory}/`)) fileOpens += 1;
            return await openSessionFile(...args);
        }) as typeof fs.open);
        const startWorker = supervisor.startSessionWorkerSupervisor;
        const delayed = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
            if (options.adopt !== undefined && options.index === 1) {
                adoptionEntered.resolve();
                await adoptionRelease.promise;
            }
            return await startWorker(options);
        });
        try {
            starting = startResidentHost({ home, config, webRoot, skipStartupDiscovery: true });
            await Promise.race([adoptionEntered.promise, Bun.sleep(10_000).then(() => { throw new Error("Adoption did not start"); })]);
            const waiting = second.location?.worker_id === "w1" ? second : first;
            expect(await locate(info.socket, waiting.id)).toMatchObject({
                type: "agent_location_failed", reason: "starting", message: "The session processes are starting.",
            });
            adoptionRelease.resolve();
            host = await starting;
            expect(reads).toHaveBeenCalledTimes(0);
            expect(snapshots).toHaveBeenCalledTimes(0);
            expect(scans).toBe(0);
            expect(fileReads).toBe(0);
            expect(fileOpens).toBe(0);
        } finally {
            reads.mockRestore();
            snapshots.mockRestore();
            directories.mockRestore();
            files.mockRestore();
            opens.mockRestore();
            delayed.mockRestore();
        }
        for (const [index, pid] of info.workers.entries()) {
            expect((await requestHostIdentity(inProcessWorkerSocket(home, index)))?.pid).toBe(pid);
        }
        const location = await locate(host!.server.socketPath, first.id);
        expect(location).toMatchObject({ type: "agent_location", worker_id: first.location?.worker_id, socket_path: first.location?.socket_path });
        const newClient = await attachAgent({ socketPath: first.location!.socket_path, agentId: first.id });
        clients.push(newClient);
        expect((await newClient.receive()).type).toBe("history");
        await clients[0]!.send({ type: "prompt", content: "Check the sails." });
        while ((await clients[0]!.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(calls).toBe(2);
    } finally {
        release.resolve();
        adoptionRelease.resolve();
        for (const client of clients) client.close();
        if (host === undefined && starting !== undefined) host = await starting.catch(() => undefined);
        const annexPid = host?.annexPid;
        await host?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const pid of [...(info?.workers ?? []), ...(info?.annexPid === undefined ? [] : [info.annexPid])]) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        stub.stop(true);
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 40_000);

test("a lost adopted session process logs unavailable exit details", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-adopt-log-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    let info: PoolInfo | undefined;
    let host: ResidentHost | undefined;
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(started, pid);
        const session = await createAgentThroughHost(info.socket, home);
        child.kill("SIGKILL");
        await child.exited;
        expect(alive(info.workers[0]!)).toBe(true);
        host = await startResidentHost({ home, config, webRoot, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true });
        expect((await requestHostIdentity(inProcessWorkerSocket(home, 0)))?.pid).toBe(info.workers[0]);
        signalStarted(started, info.workers[0]!, "SIGKILL");
        const logPath = join(home, "runtime", "logs", "host.jsonl");
        const events = (): Array<Record<string, unknown>> => existsSync(logPath)
            ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
        await waitFor(() => events().some((event) => event.type === "session_process_replaced"), "replacement log");
        const losses = events().filter((event) => event.type === "session_process_lost");
        expect(losses).toHaveLength(1);
        expect(losses[0]).toMatchObject({
            slot: "w0", generation: 1, pid: info.workers[0], exit_code: null, signal: null,
            stderr_tail: null, sessions: [session.id], resident_sessions: [session.id],
        });
    } finally {
        const annexPid = host?.annexPid;
        await host?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const pid of [...(info?.workers ?? []), ...(info?.annexPid === undefined ? [] : [info.annexPid])]) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 40_000);

test("a stop requested during adoption closes the host after startup", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-adopt-stop-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let info: PoolInfo | undefined;
    let host: ResidentHost | undefined;
    let starting: Promise<ResidentHost> | undefined;
    let restore = () => {};
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(started, pid);
        child.kill("SIGKILL");
        await child.exited;
        const startWorker = supervisor.startSessionWorkerSupervisor;
        const delayed = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
            const worker = await startWorker(options);
            if (options.adopt !== undefined) {
                entered.resolve();
                await release.promise;
            }
            return worker;
        });
        restore = () => { delayed.mockRestore(); };
        starting = startResidentHost({ home, config, webRoot, skipStartupDiscovery: true });
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Adoption did not connect"); })]);
        const identity = await requestHostIdentity(info.socket);
        expect(identity).toBeDefined();
        expect(await requestHostStop(info.socket, identity!, () => undefined)).toEqual({ type: "stopped" });
        release.resolve();
        host = await starting;
        await waitFor(() => !alive(info!.workers[0]!), "adopted worker exit");
        expect(await requestHostIdentity(info.socket)).toBeUndefined();
    } finally {
        release.resolve();
        if (host === undefined && starting !== undefined) host = await starting.catch(() => undefined);
        const annexPid = host?.annexPid;
        await host?.close();
        restore();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const pid of [...(info?.workers ?? []), ...(info?.annexPid === undefined ? [] : [info.annexPid])]) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 35_000);

test("a stop during adoption holds and waits for the surviving turn", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-adopt-stop-turn-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const turnEntered = Promise.withResolvers<void>();
    const turnRelease = Promise.withResolvers<void>();
    const adoptionEntered = Promise.withResolvers<void>();
    const adoptionRelease = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            turnEntered.resolve();
            await turnRelease.promise;
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    let info: PoolInfo | undefined;
    let client: AttachedAgentClient | undefined;
    let host: ResidentHost | undefined;
    let starting: Promise<ResidentHost> | undefined;
    let stop: ReturnType<typeof requestHostStop> | undefined;
    let restore = () => {};
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(started, pid);
        const session = await createAgentThroughHost(info.socket, home);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id,
            requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT] });
        await client.receive(AbortSignal.timeout(10_000));
        await client.send({ type: "prompt", content: "Inspect the map." });
        await Promise.race([turnEntered.promise, Bun.sleep(10_000).then(() => { throw new Error("Provider did not start"); })]);
        child.kill("SIGKILL");
        await child.exited;
        const startWorker = supervisor.startSessionWorkerSupervisor;
        const delayed = spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
            const worker = await startWorker(options);
            if (options.adopt !== undefined) {
                adoptionEntered.resolve();
                await adoptionRelease.promise;
            }
            return worker;
        });
        restore = () => { delayed.mockRestore(); };
        starting = startResidentHost({ home, config, webRoot, skipStartupDiscovery: true });
        await Promise.race([adoptionEntered.promise, Bun.sleep(10_000).then(() => { throw new Error("Adoption did not connect"); })]);
        const identity = await requestHostIdentity(info.socket);
        expect(identity).toBeDefined();
        stop = requestHostStop(info.socket, identity!, () => waiting.resolve());
        await Promise.race([waiting.promise, Bun.sleep(10_000).then(() => { throw new Error("No stop wait"); })]);
        await waitFor(() => client?.stopWait?.kind === "stop", "stop notification");
        expect(await client.send({ type: "prompt", content: "Inspect the sails." }).then(() => "accepted", (error: Error) => error.message))
            .toBe(TURNS_HELD_REFUSAL);
        expect(await Promise.race([stop.then(() => "stopped"), Bun.sleep(250).then(() => "waiting")])).toBe("waiting");
        turnRelease.resolve();
        expect(await stop).toEqual({ type: "stopped" });
        adoptionRelease.resolve();
        host = await starting;
        await waitFor(() => !alive(info!.workers[0]!), "adopted worker exit");
        await waitFor(() => !existsSync(join(home, "runtime", "host.json")), "host lock removal");
        expect(existsSync(join(home, "runtime", "host.json"))).toBe(false);
    } finally {
        turnRelease.resolve();
        adoptionRelease.resolve();
        client?.close();
        await stop?.catch(() => undefined);
        if (host === undefined && starting !== undefined) host = await starting.catch(() => undefined);
        const annexPid = host?.annexPid;
        await host?.close();
        restore();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const pid of [...(info?.workers ?? []), ...(info?.annexPid === undefined ? [] : [info.annexPid])]) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        stub.stop(true);
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 35_000);

test("adoption clears a stop wait abandoned by a dead master", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-adopt-abandoned-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const turnEntered = Promise.withResolvers<void>();
    const turnRelease = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    let calls = 0;
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            calls += 1;
            if (calls === 1) { turnEntered.resolve(); await turnRelease.promise; }
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    let info: PoolInfo | undefined;
    let client: AttachedAgentClient | undefined;
    let host: ResidentHost | undefined;
    let stop: ReturnType<typeof requestHostStop> | undefined;
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(started, pid);
        const session = await createAgentThroughHost(info.socket, home);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id,
            requestedCapabilities: [HOST_CAPABILITY_STOP_WAIT] });
        await client.receive(AbortSignal.timeout(10_000));
        await client.send({ type: "prompt", content: "Inspect the map." });
        await Promise.race([turnEntered.promise, Bun.sleep(10_000).then(() => { throw new Error("Provider did not start"); })]);
        const identity = await requestHostIdentity(info.socket);
        if (identity === undefined) throw new Error("Master identity is unavailable");
        stop = requestHostStop(info.socket, identity, () => waiting.resolve());
        await Promise.race([waiting.promise, Bun.sleep(10_000).then(() => { throw new Error("No stop wait"); })]);
        await waitFor(() => client?.stopWait?.kind === "stop", "stop notification");
        child.kill("SIGKILL");
        await child.exited;
        expect(await stop).toEqual({ type: "no_answer" });
        host = await startResidentHost({ home, config, webRoot, skipStartupDiscovery: true });
        expect((await requestHostIdentity(inProcessWorkerSocket(home)))?.pid).toBe(info.workers[0]);
        await waitFor(() => client?.stopWait === undefined, "abandoned stop notification");
        turnRelease.resolve();
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        await client.send({ type: "prompt", content: "Inspect the sails." });
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        expect(calls).toBe(2);
    } finally {
        turnRelease.resolve();
        client?.close();
        await stop?.catch(() => undefined);
        const annexPid = host?.annexPid;
        await host?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const pid of [...(info?.workers ?? []), ...(info?.annexPid === undefined ? [] : [info.annexPid])]) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        stub.stop(true);
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 35_000);

test("a reconnect waits until an adopted worker has restored its attachment services", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-adopt-ready-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let info: PoolInfo | undefined;
    let host: ResidentHost | undefined;
    let starting: Promise<ResidentHost> | undefined;
    let client: AttachedAgentClient | undefined;
    let restore = () => {};
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(started, pid);
        const session = await createAgentThroughHost(info.socket, home);
        const worker = await requestHostIdentity(inProcessWorkerSocket(home));
        child.kill("SIGKILL");
        await child.exited;
        const request = ControlPeer.prototype.request;
        const delayed = spyOn(ControlPeer.prototype, "request").mockImplementation(async function <T>(
            this: ControlPeer, method: string, args: readonly unknown[] = [], signal?: AbortSignal,
        ): Promise<T> {
            if (method === "worker.activate") {
                entered.resolve();
                await release.promise;
            }
            return await request.call(this, method, args, signal) as T;
        });
        restore = () => { delayed.mockRestore(); };
        starting = startResidentHost({ home, config, webRoot, skipStartupDiscovery: true });
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Activation did not start"); })]);
        expect(await locate(info.socket, session.id)).toMatchObject({
            type: "agent_location_failed", reason: "worker_unavailable",
        });
        const reconnecting = attachReconnectingAgent({ socketPath: () => info!.socket, agentId: session.id,
            buildId: worker!.build_id!, interactive: true, clientId: "reconnect-test" });
        await Bun.sleep(250);
        release.resolve();
        client = await reconnecting;
        expect((await client.receive()).type).toBe("history");
        host = await starting;
        expect((await requestHostIdentity(inProcessWorkerSocket(home)))?.pid).toBe(info.workers[0]);
    } finally {
        release.resolve();
        if (host === undefined && starting !== undefined) host = await starting.catch(() => undefined);
        client?.close();
        const annexPid = host?.annexPid;
        await host?.close();
        restore();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const pid of [...(info?.workers ?? []), ...(info?.annexPid === undefined ? [] : [info.annexPid])]) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (annexPid !== undefined) await waitFor(() => !alive(annexPid), "replacement annex exit");
        await stderr;
        await rm(home, { recursive: true, force: true });
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
test("a stop refused during adoption never takes effect later", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h9-adopt-slow-stop-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const turnEntered = Promise.withResolvers<void>();
    const turnRelease = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            turnEntered.resolve();
            await turnRelease.promise;
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "15000"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    let info: PoolInfo | undefined;
    let client: AttachedAgentClient | undefined;
    let stopReplacement = async (): Promise<void> => {};
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(started, pid);
        const session = await createAgentThroughHost(info.socket, home);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        await client.receive(AbortSignal.timeout(10_000));
        await client.send({ type: "prompt", content: "Inspect the map." });
        await Promise.race([turnEntered.promise, Bun.sleep(10_000).then(() => { throw new Error("Provider did not start"); })]);
        child.kill("SIGKILL");
        await child.exited;
        const replacement = Bun.spawn([process.execPath, "test/host/fixtures/pool-slow-adoption-host.ts"], {
            cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
        });
        const replacementStderr = new Response(replacement.stderr).text();
        stopReplacement = async () => {
            if (replacement.exitCode === null && replacement.signalCode === null) replacement.kill("SIGTERM");
            const exited = await Promise.race([replacement.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
            if (!exited) replacement.kill("SIGKILL");
            await replacement.exited;
            await replacementStderr;
        };
        await waitFor(() => existsSync(join(home, "adoption-entered")) || replacement.exitCode !== null, "adoption startup");
        if (!existsSync(join(home, "adoption-entered"))) throw new Error(`Replacement failed: ${await replacementStderr}`);
        expect((await requestHostIdentity(info.socket))?.pid).toBe(replacement.pid);
        let output = "";
        let error = "";
        const refused = await runCli(["host", "stop"], {
            confirmHostStop: async () => true,
            stdout: { write: (text) => { output += text; } },
            stderr: { write: (text) => { error += text; } },
        });
        expect({ refused, output, error }).toEqual({
            refused: 1, output: "", error: `Resident host startup is already in progress (PID ${replacement.pid})\n`,
        });
        await writeFile(join(home, "adoption-release"), "");
        await waitFor(() => existsSync(join(home, "adoption-ready.json")) || replacement.exitCode !== null, "adoption completion");
        if (!existsSync(join(home, "adoption-ready.json"))) throw new Error(`Replacement failed: ${await replacementStderr}`);
        const adopted = JSON.parse(await readFile(join(home, "adoption-ready.json"), "utf8")) as { annexPid?: number };
        if (adopted.annexPid !== undefined) remember(started, adopted.annexPid);
        expect((await requestHostIdentity(inProcessWorkerSocket(home)))?.pid).toBe(info.workers[0]);
        turnRelease.resolve();
        while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
        await Bun.sleep(1_250);
        expect(alive(replacement.pid)).toBe(true);
        expect(alive(info.workers[0]!)).toBe(true);
        expect(existsSync(join(home, "runtime", "host.json"))).toBe(true);
        output = "";
        error = "";
        const stopped = await runCli(["host", "stop"], {
            confirmHostStop: async () => true,
            stdout: { write: (text) => { output += text; } },
            stderr: { write: (text) => { error += text; } },
        });
        expect({ stopped, output, error }).toEqual({
            stopped: 0, output: `Stopped resident Vera host PID ${replacement.pid} after its running turns ended.\n`, error: "",
        });
        expect(await replacement.exited).toBe(0);
        expect(alive(replacement.pid)).toBe(false);
        expect(alive(info.workers[0]!)).toBe(false);
        expect(existsSync(join(home, "runtime", "host.json"))).toBe(false);
    } finally {
        turnRelease.resolve();
        await writeFile(join(home, "adoption-release"), "").catch(() => {});
        client?.close();
        await stopReplacement();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        for (const pid of [...(info?.workers ?? []), ...(info?.annexPid === undefined ? [] : [info.annexPid])]) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        for (const pid of started.keys()) {
            if (alive(pid)) signalStarted(started, pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        stub.stop(true);
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 35_000);
