import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkRecordIdentity, processCommandLine, processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { socketTest } from "../support/socket-probe.ts";
import { sourceTestHome } from "../support/source-test-home.mjs";

interface WorkerRecord {
    readonly pid: number;
    readonly host_pid: number;
    readonly started_at: string;
}

for (const fault of ["uncaught_exception", "unhandled_rejection"] as const) {
    socketTest(`a session process records ${fault} before exit`, async () => {
        const root = await mkdtemp(join(tmpdir(), "hsf-"));
        const control = join(root, "control.sock");
        const sockets: Socket[] = [];
        const server = createServer((socket) => { sockets.push(socket); });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(control, resolve);
        });
        const child = Bun.spawn([process.execPath, "-e", `
            import { runSessionWorkerEntrypoint } from "./clients/host/session-worker.ts";
            process.argv = [process.execPath, "worker-fixture", "--worker-index", "0", "--worker-count", "1",
                "--worker-generation", "1", "--control", ${JSON.stringify(control)}, "--socket", ${JSON.stringify(join(root, "worker.sock"))}];
            const running = runSessionWorkerEntrypoint();
            setTimeout(() => {
                if (${JSON.stringify(fault)} === "uncaught_exception") throw new Error("worker fault");
                Promise.reject(new Error("worker fault"));
            }, 100);
            await running;
        `], {
            cwd: process.cwd(),
            env: { ...process.env, HOME: sourceTestHome(join(root, "user")), VERA_HOME: root, VERA_DEV_INSTANCE: "hoststop dev" },
            stdout: "ignore", stderr: "pipe",
        });
        const stderr = new Response(child.stderr).text();
        try {
            const outcome = await Promise.race([child.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
            expect(outcome).toBe(1);
            const entries = (await readFile(join(root, "runtime", "logs", "host.jsonl"), "utf8"))
                .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(entries).toContainEqual(expect.objectContaining({
                type: "host_stopping", role: "worker", pid: child.pid, reason: fault, error: "worker fault",
            }));
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await child.exited;
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await stderr;
            await rm(root, { recursive: true, force: true });
        }
    }, 10_000);
}

socketTest("a session process records loss of its host after the adoption grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "hsp-"));
    const home = join(root, "h");
    await mkdir(home);
    const child = Bun.spawn([process.execPath, "-e", `
        import { startResidentHost } from "./src/host/runtime.ts";
        import { runResidentHostProcess } from "./clients/host/process-lifecycle.ts";
        const host = await startResidentHost({
            home: ${JSON.stringify(home)}, processWorker: true, processWorkerCount: 1,
            processWorkerHostGraceMs: 200, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
            },
        });
        await runResidentHostProcess(host);
    `], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: sourceTestHome(join(root, "user")), VERA_HOME: home, VERA_DEV_INSTANCE: "hoststop dev" },
        stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    let worker: WorkerRecord | undefined;
    try {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error("Host exited during startup.");
            const record = await readFile(join(home, "runtime", "workers", "w0.json"), "utf8")
                .then((data) => JSON.parse(data) as WorkerRecord, () => undefined);
            const identity = await requestHostIdentity(join(home, "runtime", "host.sock"));
            if (record?.host_pid === child.pid && identity?.workers_ready === 1) {
                worker = record;
                break;
            }
            await Bun.sleep(25);
        }
        expect(worker).toBeDefined();
        if (worker === undefined) throw new Error("Session process did not start.");
        expect(checkRecordIdentity(worker)).toBe("match");
        expect(processCommandLine(worker.pid)).toContain(process.cwd());
        child.kill("SIGKILL");
        await child.exited;
        let entry: Record<string, unknown> | undefined;
        const stopDeadline = Date.now() + 10_000;
        while (Date.now() < stopDeadline && entry === undefined) {
            const content = await readFile(join(home, "runtime", "logs", "host.jsonl"), "utf8").catch(() => "");
            entry = content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
                .find((value) => value.type === "host_stopping" && value.pid === worker!.pid);
            if (entry === undefined) await Bun.sleep(25);
        }
        expect(entry).toMatchObject({ reason: "host_lost", role: "worker", pid: worker.pid });
        while (processIsAlive(worker.pid) && checkRecordIdentity(worker) === "match" && Date.now() < stopDeadline) {
            await Bun.sleep(25);
        }
        expect(processIsAlive(worker.pid) && checkRecordIdentity(worker) === "match").toBe(false);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        if (worker !== undefined && processIsAlive(worker.pid) && checkRecordIdentity(worker) === "match"
            && processCommandLine(worker.pid)?.includes(process.cwd())) {
            process.kill(worker.pid, "SIGKILL");
        }
        await stderr;
        await rm(root, { recursive: true, force: true });
    }
}, 40_000);

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL", "HOST_REQUEST"] as const) {
    socketTest(`a session process stopped by ${signal} leaves a record`, async () => {
        const root = await mkdtemp(join(tmpdir(), "hsw-"));
        const home = join(root, "h");
        await mkdir(home);
        await writeFile(join(home, "config.json"), JSON.stringify({
            schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
            providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
            host: { workers: 1 },
        }));
        const host = Bun.spawn([process.execPath, "clients/host/main.ts", "--no-discovery"], {
            cwd: process.cwd(),
            env: { ...process.env, HOME: sourceTestHome(join(root, "user")), VERA_HOME: home, VERA_DEV_INSTANCE: "hoststop dev" },
            stdout: "ignore", stderr: "pipe",
        });
        const stderr = new Response(host.stderr).text();
        const workers: WorkerRecord[] = [];
        const logPath = join(home, "runtime", "logs", "host.jsonl");
        const readEntries = async (): Promise<Record<string, unknown>[]> => {
            const content = await readFile(logPath, "utf8").catch(() => "");
            return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        };
        const waitForWorker = async (previous?: number): Promise<WorkerRecord> => {
            const deadline = Date.now() + 25_000;
            while (Date.now() < deadline) {
                if (host.exitCode !== null || host.signalCode !== null) throw new Error("Host exited during worker startup.");
                const worker = await readFile(join(home, "runtime", "workers", "w0.json"), "utf8")
                    .then((data) => JSON.parse(data) as WorkerRecord, () => undefined);
                const identity = await requestHostIdentity(join(home, "runtime", "host.sock"));
                if (worker !== undefined && worker.host_pid === host.pid && worker.pid !== previous
                    && identity?.pid === host.pid && identity.workers_ready === 1) return worker;
                await Bun.sleep(25);
            }
            throw new Error("Session process did not start.");
        };
        try {
            const worker = await waitForWorker();
            workers.push(worker);
            expect(checkRecordIdentity(worker)).toBe("match");
            expect(processCommandLine(worker.pid)).toContain(process.cwd());
            if (signal === "HOST_REQUEST") host.kill("SIGTERM");
            else process.kill(worker.pid, signal);
            const deadline = Date.now() + 20_000;
            let event: Record<string, unknown> | undefined;
            while (Date.now() < deadline && event === undefined) {
                event = (await readEntries()).find((entry) => entry.pid === worker.pid
                    && entry.type === (signal === "SIGKILL" ? "session_process_lost" : "host_stopping"));
                if (event === undefined) await Bun.sleep(25);
            }
            if (signal === "SIGKILL") {
                expect(event).toMatchObject({ type: "session_process_lost", pid: worker.pid, signal: "SIGKILL" });
            } else if (signal === "HOST_REQUEST") {
                expect(event).toMatchObject({ type: "host_stopping", role: "worker", pid: worker.pid, reason: "host_request" });
            } else {
                expect(event).toMatchObject({ type: "host_stopping", role: "worker", pid: worker.pid, reason: "signal", signal });
            }
            if (signal === "HOST_REQUEST") expect(await host.exited).toBe(0);
            else workers.push(await waitForWorker(worker.pid));
        } finally {
            if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
            await Promise.race([host.exited, Bun.sleep(8_000)]);
            if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
            await host.exited;
            for (const worker of workers) {
                if (processIsAlive(worker.pid) && checkRecordIdentity(worker) === "match"
                    && processCommandLine(worker.pid)?.includes(process.cwd())) {
                    process.kill(worker.pid, "SIGKILL");
                }
            }
            const deadline = Date.now() + 5_000;
            while (workers.some((worker) => processIsAlive(worker.pid) && checkRecordIdentity(worker) === "match")
                && Date.now() < deadline) await Bun.sleep(25);
            expect(workers.every((worker) => !processIsAlive(worker.pid) || checkRecordIdentity(worker) !== "match")).toBe(true);
            await stderr;
            await rm(root, { recursive: true, force: true });
        }
    }, 60_000);
}
