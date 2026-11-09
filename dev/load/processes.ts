import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { assertTrialHome, command, log, REPO } from "./common.ts";
import { readRecordedWorkers } from "../../src/host/pool/worker-records.ts";
import type { ProfileRuntime } from "./profile.ts";

interface OwnedProcess {
    pid: number;
    role: string;
    home: string;
    child?: ReturnType<typeof Bun.spawn>;
}

export interface StopMeasurement {
    readonly elapsedMs: number | null;
    readonly awakeElapsedMs: number | null;
    readonly commandExit: number | null;
    readonly pids: readonly number[];
    readonly remainingPids: readonly number[];
    readonly remainingRecords: readonly string[];
}

export class ProcessOwner {
    readonly processes: OwnedProcess[] = [];
    constructor(readonly run: string, readonly home: string) { assertTrialHome(home); }

    start(role: string, script: string, extra: Record<string, string> = {}, preload?: string, args: readonly string[] = [], runtime?: ProfileRuntime) {
        const userHome = join(this.run, "user");
        mkdirSync(userHome, { recursive: true });
        const env: Record<string, string> = {
            PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp",
            LANG: "en_US.UTF-8", HOME: userHome, VERA_HOME: this.home,
            VERA_DEV_INSTANCE: `${basename(REPO)} dev`, LOAD_RUN: this.run,
            ...extra,
        };
        const child = Bun.spawn([runtime?.executable ?? process.execPath, ...(runtime?.flags ?? []), ...(preload ? ["--preload", preload] : []), script, ...args], {
            cwd: REPO, env,
            stdout: Bun.file(join(this.run, `${role}.stdout`)),
            stderr: Bun.file(join(this.run, `${role}.stderr`)),
        });
        const owned = { pid: child.pid, role, home: this.home, child };
        this.processes.push(owned);
        log(join(this.run, "pids.ndjson"), { type: "start", pid: child.pid, role, home: this.home, script });
        void child.exited.then((code) => log(join(this.run, "pids.ndjson"), { type: "exit", pid: child.pid, role, code }));
        return child;
    }

    async discoverDescendants(): Promise<void> {
        const table = await command(["/bin/ps", "-axo", "pid=,ppid=,command="]);
        const candidates = table.split("\n").flatMap((line) => {
            const found = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
            return found ? [{ pid: Number(found[1]), parent: Number(found[2]), command: found[3]! }] : [];
        });
        let changed = true;
        while (changed) {
            changed = false;
            for (const candidate of candidates) {
                if (this.processes.some((owned) => owned.pid === candidate.pid)
                    || !this.processes.some((owned) => owned.pid === candidate.parent)) continue;
                if (!candidate.command.includes(REPO)) continue;
                if (!await this.matches(candidate.pid)) continue;
                this.processes.push({ pid: candidate.pid, role: "descendant", home: this.home });
                log(join(this.run, "pids.ndjson"), { type: "discovered", ...candidate, home: this.home });
                changed = true;
            }
        }
    }

    private async matches(pid: number): Promise<boolean> {
        try {
            const text = await command(["/bin/ps", "eww", "-p", String(pid), "-o", "command="]);
            return text.includes(REPO) && text.includes(`VERA_HOME=${this.home}`) && this.home.includes("/vera-dev/");
        } catch { return false; }
    }

    async killWorker(pid: number): Promise<void> {
        await this.discoverDescendants();
        if (!this.processes.some((process) => process.pid === pid && process.role === "descendant") || !await this.matches(pid)) {
            throw new Error(`Session process ${pid} does not belong to this trial`);
        }
        const commandLine = await command(["/bin/ps", "-p", String(pid), "-o", "command="]);
        if (!commandLine.includes("--worker-index")) throw new Error(`Process ${pid} is not a session process`);
        process.kill(pid, "SIGKILL");
        log(join(this.run, "pids.ndjson"), { type: "signal", pid, signal: "SIGKILL" });
    }

    async stopHost(): Promise<StopMeasurement> {
        await this.discoverDescendants();
        const host = this.processes.find((process) => process.role === "host");
        const workers = await readRecordedWorkers(this.home);
        const pids = [...new Set([...(host === undefined ? [] : [host.pid]), ...workers.map((worker) => worker.pid)])];
        const started = performance.now();
        const startedWall = Date.now();
        const cli = this.start("stop", join(REPO, "clients/cli/main.ts"), {}, undefined, ["host", "stop", "--yes"]);
        const deadline = started + 180_000;
        let remaining = pids;
        while (performance.now() < deadline) {
            for (const worker of await readRecordedWorkers(this.home)) {
                if (!pids.includes(worker.pid)) pids.push(worker.pid);
            }
            const alive = await Promise.all(pids.map(async (pid) => await this.matches(pid)));
            remaining = pids.filter((_, index) => alive[index]);
            if (remaining.length === 0) break;
            await Bun.sleep(50);
        }
        const elapsedMs = remaining.length === 0 ? Date.now() - startedWall : null;
        const awakeElapsedMs = remaining.length === 0 ? performance.now() - started : null;
        await Promise.race([cli.exited, Bun.sleep(1_000)]);
        const records = await readRecordedWorkers(this.home);
        const result: StopMeasurement = {
            elapsedMs, awakeElapsedMs, commandExit: cli.exitCode, pids, remainingPids: remaining,
            remainingRecords: records.map((record) => record.path),
        };
        log(join(this.run, "stop.ndjson"), { type: "stop", ...result });
        return result;
    }

    async stop(): Promise<void> {
        await this.discoverDescendants();
        for (const owned of this.processes.filter((process) => process.role === "host")) {
            if (!await this.matches(owned.pid)) continue;
            process.kill(owned.pid, "SIGTERM");
            log(join(this.run, "pids.ndjson"), { type: "signal", pid: owned.pid, signal: "SIGTERM" });
            if (owned.child !== undefined) await Promise.race([owned.child.exited, Bun.sleep(4_000)]);
        }
        await this.discoverDescendants();
        for (const owned of [...this.processes].reverse()) {
            if (owned.child?.exitCode !== null && owned.child?.exitCode !== undefined) continue;
            if (await this.matches(owned.pid)) {
                process.kill(owned.pid, "SIGTERM");
                log(join(this.run, "pids.ndjson"), { type: "signal", pid: owned.pid, signal: "SIGTERM" });
            }
        }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const alive = await Promise.all(this.processes.map((owned) => this.matches(owned.pid)));
            if (!alive.some(Boolean)) break;
            await Bun.sleep(200);
        }
        for (const owned of this.processes) {
            if (await this.matches(owned.pid)) {
                process.kill(owned.pid, "SIGKILL");
                log(join(this.run, "pids.ndjson"), { type: "signal", pid: owned.pid, signal: "SIGKILL" });
            }
        }
        await Promise.all(this.processes.flatMap((owned) => owned.child ? [owned.child.exited] : []));
        await Bun.sleep(100);
        const survivors: number[] = [];
        for (const owned of this.processes) if (await this.matches(owned.pid)) survivors.push(owned.pid);
        log(join(this.run, "pids.ndjson"), { type: "cleanup", survivors });
        if (survivors.length) throw new Error(`Trial processes survived cleanup: ${survivors.join(", ")}`);
    }
}
