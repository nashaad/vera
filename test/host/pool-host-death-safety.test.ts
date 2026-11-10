import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdirSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentThroughHost, resumeAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { ensureResidentHost } from "../../src/host/discovery.ts";
import { createHostLockfile } from "../../src/host/lockfile.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { CRASH_CUT_MESSAGE, readSessionTurnState, WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";
import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";

interface PoolHostInfo {
    readonly pid: number;
    readonly workerPid: number;
    readonly annexPid?: number;
    readonly socket: string;
}

interface StartedProcess {
    readonly startedAt: number;
    readonly command: string;
}

socketAndLoopbackTest("ordinary discovery does not reopen a session held by a surviving worker", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h8b-safety-"));
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            entered.resolve();
            await release.promise;
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
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-crash-host.ts"], {
        cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, StartedProcess>();
    let info: PoolHostInfo | undefined;
    let client: AttachedAgentClient | undefined;
    let replacement: ResidentHost | undefined;
    let replacementWorkerPid: number | undefined;
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolHostInfo;
        expect(info.pid).toBe(child.pid);
        remember(started, info.workerPid);
        if (info.annexPid !== undefined) remember(started, info.annexPid);
        const session = await createAgentThroughHost(info.socket, home);
        const path = join(home, "runtime", "sessions", `${session.id}.jsonl`);
        client = await attachAgent({ socketPath: session.location!.socket_path, agentId: session.id });
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content: "Inspect the map." });
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Provider did not start"); })]);
        expect((await readSessionTurnState(path)).turnOpen).toBe(true);
        signalStarted(started, info.workerPid, "SIGSTOP");
        await waitFor(() => stopped(info!.workerPid), "worker to stop");
        child.kill("SIGKILL");
        await child.exited;
        await waitFor(() => !alive(child.pid), "host exit");

        const lockfile = createHostLockfile({
            path: join(home, "runtime", "host.json"), socketPath: info.socket,
        });
        await ensureResidentHost({
            lockfile,
            startupTimeoutMs: 15_000,
            async startHost() {
                replacement = await startResidentHost({ home, config, webRoot, skipStartupDiscovery: true,
                    processWorkerHeartbeatDeadlineMs: 500 });
            },
        });
        expect(replacement).toBeDefined();
        expect(alive(info.workerPid)).toBe(false);
        replacementWorkerPid = (await requestHostIdentity(inProcessWorkerSocket(home)))?.pid;
        expect(replacementWorkerPid).toBeDefined();
        expect(replacementWorkerPid).not.toBe(info.workerPid);
        const afterRecovery = await readFile(path, "utf8");
        const resumed = await resumeAgentThroughHost(replacement!.server.socketPath, path);
        expect(resumed.id).toBe(session.id);
        console.info(`Host ${info.pid}, worker ${info.workerPid}, replacement ${process.pid}`);
        expect({
            replacementOwnsSession: replacement!.registry.agents.has(session.id),
            crashCutWritten: afterRecovery.includes(CRASH_CUT_MESSAGE),
            failedTurns: afterRecovery.split(WORKER_EXIT_TURN_MESSAGE).length - 1,
        }).toEqual({
            replacementOwnsSession: false,
            crashCutWritten: false,
            failedTurns: 1,
        });
    } finally {
        release.resolve();
        client?.close();
        const replacementAnnex = replacement?.annexPid;
        await replacement?.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        if (info !== undefined && alive(info.workerPid)) signalStarted(started, info.workerPid, "SIGKILL");
        if (info?.annexPid !== undefined && alive(info.annexPid)) signalStarted(started, info.annexPid, "SIGKILL");
        for (const pid of [info?.workerPid, info?.annexPid]) {
            if (pid !== undefined) await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        if (replacementAnnex !== undefined) await waitFor(() => !alive(replacementAnnex), "replacement annex exit");
        if (replacementWorkerPid !== undefined) await waitFor(() => !alive(replacementWorkerPid!), "replacement worker exit");
        stub.stop(true);
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 40_000);

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
