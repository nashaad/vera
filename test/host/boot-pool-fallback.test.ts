import { expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { sourceTestHome } from "../support/source-test-home.mjs";
import { recoverHome } from "../../clients/host/launch.ts";
import { cliHostRequester } from "../../src/host/requester.ts";
import { bootResidentHost } from "../../src/host/boot.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";

interface ProcessRecord {
    readonly pid: number;
    readonly build_id: string;
}

function alive(pid: number): boolean {
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    return state.length > 0 && !state.startsWith("Z");
}

function verified(pid: number, home: string, role: string): boolean {
    const output = spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" }).stdout;
    return output.includes(`VERA_HOME=${home}`) && output.includes(role);
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = performance.now() + 20_000;
    while (!await check()) {
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await Bun.sleep(25);
    }
}

socketAndLoopbackTest("startup resets a worker whose identity differs from its record", async () => {
    const root = mkdtempSync(join(tmpdir(), "boot-pool-"));
    const home = join(root, "h");
    const env = { ...process.env, HOME: sourceTestHome(root), VERA_HOME: home, VERA_DEV_INSTANCE: "dropwork dev", TMPDIR: root };
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
    }));
    const child = spawn(process.execPath, ["clients/host/main.ts"], { cwd: process.cwd(), env, argv0: "vera-host", stdio: "ignore" });
    const workers = new Set<number>();
    const workerRecord = join(home, "runtime", "workers", "w0.json");
    const hostRecord = join(home, "runtime", "host.json");
    const read = (path: string): ProcessRecord | undefined => {
        try { return JSON.parse(readFileSync(path, "utf8")) as ProcessRecord; } catch { return undefined; }
    };
    let newHost: number | undefined;
    try {
        await waitFor(() => read(workerRecord)?.pid !== undefined && read(hostRecord)?.pid === child.pid, "initial pool");
        const initial = read(workerRecord)!;
        expect(initial.build_id).toBe("dev");
        workers.add(initial.pid);
        if (child.pid === undefined || !verified(child.pid, home, "vera-host")) throw new Error("Could not verify test host");
        child.kill("SIGKILL");
        await waitFor(() => !alive(child.pid!), "old host exit");
        writeFileSync(workerRecord, JSON.stringify({ ...initial, build_id: "incompatible-build" }));
        const boot = Bun.spawn([process.execPath, "clients/cli/main.ts", "boot", "--json"], {
            cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
        });
        const [output, errors, code] = await Promise.all([new Response(boot.stdout).text(), new Response(boot.stderr).text(), boot.exited]);
        expect({ code, errors }).toEqual({ code: 0, errors: "" });
        expect(output).toContain('"label":"Recovery"');
        newHost = read(hostRecord)?.pid;
        await waitFor(() => {
            const record = read(workerRecord);
            return record !== undefined && record.pid !== initial.pid;
        }, "replacement worker");
        const replacement = read(workerRecord)!;
        expect(replacement.build_id).toBe("dev");
        expect(read(hostRecord)?.build_id).toBe("dev");
        workers.add(replacement.pid);
        expect(alive(initial.pid)).toBe(false);
        expect(newHost).toBeDefined();
        expect(newHost).not.toBe(child.pid);
    } finally {
        const currentHost = newHost ?? read(hostRecord)?.pid;
        if (currentHost !== undefined && alive(currentHost) && verified(currentHost, home, "vera-host")) process.kill(currentHost, "SIGTERM");
        if (child.pid !== undefined && alive(child.pid) && verified(child.pid, home, "vera-host")) child.kill("SIGTERM");
        const directory = join(home, "runtime", "workers");
        if (existsSync(directory)) {
            for (const name of readdirSync(directory)) {
                const record = read(join(directory, name));
                if (record !== undefined) workers.add(record.pid);
            }
        }
        for (const pid of workers) {
            if (alive(pid) && verified(pid, home, "session-worker")) process.kill(pid, "SIGTERM");
        }
        if (currentHost !== undefined) await waitFor(() => !alive(currentHost), "new host exit");
        if (child.pid !== undefined) await waitFor(() => !alive(child.pid!), "old host exit");
        for (const pid of workers) await waitFor(() => !alive(pid), `worker ${pid} exit`);
        rmSync(root, { recursive: true, force: true });
    }
}, 45_000);

socketAndLoopbackTest("a host started before a simulated adoption timeout exits cleanly before a fresh start", async () => {
    const root = mkdtempSync(join(tmpdir(), "boot-retry-"));
    const home = join(root, "h");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
    }));
    const env = { ...process.env, HOME: sourceTestHome(root), VERA_HOME: home, VERA_DEV_INSTANCE: "dropwork dev", TMPDIR: root };
    const oldHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const children: ReturnType<typeof spawn>[] = [];
    const hostRecord = join(home, "runtime", "host.json");
    const startHost = async (): Promise<HostLockRecord> => {
        const child = spawn(process.execPath, ["clients/host/main.ts", "--single-process"], {
            cwd: process.cwd(), env, argv0: "vera-host", stdio: "ignore",
        });
        children.push(child);
        let record: HostLockRecord | undefined;
        await waitFor(async () => {
            try { record = JSON.parse(readFileSync(hostRecord, "utf8")) as HostLockRecord; } catch { return false; }
            if (record.pid !== child.pid) return false;
            return (await requestHostIdentity(record.socket_path))?.pid === child.pid;
        }, "host publication");
        return record!;
    };
    let attemptedPid: number | undefined;
    let replacementPid: number | undefined;
    const checks: { readonly label: string; readonly status: string; readonly detail?: string }[] = [];
    try {
        const host = await bootResidentHost({
            full: true,
            inspect: async () => ({ home, hostAnswers: false, lock: "stale", orphans: 1, unproven: 0, bootLoop: false }),
            adopt: async () => {
                attemptedPid = (await startHost()).pid;
                throw new Error("Session processes could not be adopted");
            },
            recover: async () => {
                const result = await recoverHome(cliHostRequester("startup"));
                expect(result.ok).toBe(true);
                expect(attemptedPid).toBeDefined();
                expect(alive(attemptedPid!)).toBe(false);
                await waitFor(() => children[0]!.exitCode !== null || children[0]!.signalCode !== null, "first host exit status");
                expect(children[0]!.exitCode).toBe(0);
                expect(children[0]!.signalCode).toBeNull();
                return result;
            },
            start: async () => {
                expect(attemptedPid).toBeDefined();
                expect(alive(attemptedPid!)).toBe(false);
                const replacement = await startHost();
                replacementPid = replacement.pid;
                return replacement;
            },
            rollback: async () => undefined,
            clearBootFailures: () => {},
            confirm: async () => true,
            render: (result) => { checks.push(...result); },
        });
        expect(replacementPid).toBe(host.pid);
        expect(host.pid).not.toBe(attemptedPid);
        expect(alive(host.pid)).toBe(true);
        expect(checks).toContainEqual({
            label: "Session processes", status: "warn", detail: "Session processes could not be adopted",
        });
    } finally {
        for (const child of children) {
            if (child.pid !== undefined && alive(child.pid) && verified(child.pid, home, "vera-host")) child.kill("SIGTERM");
        }
        for (const child of children) {
            if (child.pid !== undefined) await waitFor(() => !alive(child.pid!), "test host exit");
        }
        if (oldHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = oldHome;
        rmSync(root, { recursive: true, force: true });
    }
}, 60_000);
