import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { connectHost } from "../../src/host/connection.ts";
import { ensureResidentHost } from "../../src/host/discovery.ts";
import { createHostLockfile } from "../../src/host/lockfile.ts";
import { inProcessWorkerSocket } from "../../src/host/master/in-process.ts";
import { processCommandLine, processStartedAt } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";

interface PoolInfo {
    readonly pid: number;
    readonly workers: readonly number[];
    readonly annexPid?: number;
    readonly socket: string;
}

test("ordinary discovery answers while the master supervises a silent worker", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/h8b-discovery-");
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
    }));
    const environment = { ...process.env, VERA_HOME: home };
    const child = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "30000"], {
        cwd: process.cwd(), env: environment, stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const started = new Map<number, { startedAt: number; command: string }>();
    let replacement: ReturnType<typeof Bun.spawn> | undefined;
    let replacementPid: number | undefined;
    let replacementStderr: Promise<string> | undefined;
    let info: PoolInfo | undefined;
    const previousHome = process.env.VERA_HOME;
    const remember = (pid: number): void => {
        const startedAt = processStartedAt(pid);
        const command = processCommandLine(pid);
        if (startedAt === undefined || command === undefined) throw new Error(`Could not inspect process ${pid}`);
        started.set(pid, { startedAt, command });
    };
    const signal = (pid: number, name: NodeJS.Signals): void => {
        const recorded = started.get(pid);
        const startedAt = processStartedAt(pid);
        if (recorded === undefined || startedAt === undefined || Math.abs(startedAt - recorded.startedAt) > 2_000
            || processCommandLine(pid) !== recorded.command) throw new Error(`Process ${pid} no longer matches`);
        try { process.kill(pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    try {
        await waitFor(() => existsSync(join(home, "ready.json")) || child.exitCode !== null, "pool startup");
        if (!existsSync(join(home, "ready.json"))) throw new Error(`Pool host failed: ${await stderr}`);
        info = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        for (const pid of [...info.workers, ...(info.annexPid === undefined ? [] : [info.annexPid])]) remember(pid);
        await createAgentThroughHost(info.socket, home);
        signal(info.workers[0]!, "SIGSTOP");
        await waitFor(() => stopped(info!.workers[0]!), "worker to stop");
        child.kill("SIGKILL");
        await child.exited;
        process.env.VERA_HOME = home;
        const lockfile = createHostLockfile({ path: join(home, "runtime", "host.json"), socketPath: info.socket });
        const start = Date.now();
        const record = await ensureResidentHost({
            lockfile,
            startHost() {
                const spawned = Bun.spawn([process.execPath, "test/host/fixtures/pool-adoption-host.ts", "1", "30000", "auto"], {
                    cwd: process.cwd(), env: environment, stdout: "ignore", stderr: "pipe",
                });
                replacement = spawned;
                replacementPid = spawned.pid;
                replacementStderr = new Response(spawned.stderr).text();
            },
        });
        expect(replacementPid).toBeDefined();
        expect(record.pid).toBe(replacementPid!);
        expect(alive(info.workers[0]!)).toBe(true);
        expect((await requestHostIdentity(info.socket))?.workers_ready).toBe(0);
        const connection = await connectHost({ socketPath: info.socket });
        try {
            await connection.send({ type: "locate_agent", agent_id: "unclaimed" });
            expect(await connection.receive()).toMatchObject({ type: "agent_location_failed", reason: "starting" });
        } finally { connection.close(); }
        await waitFor(() => !alive(info!.workers[0]!), "silent worker exit");
        expect(Date.now() - start).toBeGreaterThanOrEqual(9_000);
        await waitFor(() => {
            try { return JSON.parse(readFileSync(join(home, "ready.json"), "utf8")).pid === replacement!.pid; }
            catch { return false; }
        }, "replacement ready");
        expect(alive(info.workers[0]!)).toBe(false);
        const identity = await requestHostIdentity(inProcessWorkerSocket(home));
        expect(identity?.pid).toBeDefined();
        expect(identity?.pid).not.toBe(info.workers[0]);
        remember(identity!.pid);
        const next = JSON.parse(await readFile(join(home, "ready.json"), "utf8")) as PoolInfo;
        if (next.annexPid !== undefined) remember(next.annexPid);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        if (replacement !== undefined) {
            const names = await readdir(join(home, "runtime", "workers")).catch(() => []);
            for (const name of names.filter((value) => value.endsWith(".json"))) {
                const record = JSON.parse(await readFile(join(home, "runtime", "workers", name), "utf8")) as { pid: number };
                if (alive(record.pid) && !started.has(record.pid)) remember(record.pid);
            }
            if (alive(replacement.pid)) {
                const children = Bun.spawnSync(["pgrep", "-P", String(replacement.pid)]).stdout.toString("utf8");
                for (const pid of children.trim().split(/\s+/).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)) {
                    if (alive(pid) && !started.has(pid)) remember(pid);
                }
            }
            if (replacement.exitCode === null && replacement.signalCode === null) replacement.kill("SIGTERM");
            await replacement.exited;
            await replacementStderr;
        }
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await child.exited;
        for (const pid of started.keys()) {
            if (alive(pid)) signal(pid, "SIGKILL");
            await waitFor(() => !alive(pid), `process ${pid} exit`);
        }
        await stderr;
        await rm(home, { recursive: true, force: true });
    }
}, 35_000);

function stopped(pid: number): boolean {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="]);
    return result.exitCode === 0 && result.stdout.toString().trim().startsWith("T");
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(10);
    }
}
