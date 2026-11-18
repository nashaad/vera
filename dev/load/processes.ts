import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { assertTrialHome, command, log, REPO } from "./common.ts";
import { readRecordedWorkers } from "../../src/host/pool/worker-records.ts";
import type { ProfileRuntime } from "./profile.ts";
import { processStart, type ProcessIdentity } from "./identity.ts";

interface OwnedProcess {
    pid: number;
    role: string;
    home: string;
    started: string | null;
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
    private readonly recordedWorkers = new Set<number>();
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
        const owned: OwnedProcess = { pid: child.pid, role, home: this.home, started: null, child };
        this.processes.push(owned);
        void child.exited.then((code) => log(join(this.run, "pids.ndjson"), { type: "exit", pid: child.pid, role, code }));
        owned.started = processStart(child.pid) ?? null;
        log(join(this.run, "pids.ndjson"), { type: "start", pid: child.pid, role, home: this.home, script });
        return child;
    }

    async discoverDescendants(existingTable?: string): Promise<void> {
        const table = existingTable ?? await command(["/bin/ps", "-axo", "pid=,ppid=,command="]);
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
                if (!candidate.command.includes(REPO) || !await this.matches(candidate.parent)) continue;
                const started = processStart(candidate.pid);
                if (started === undefined) continue;
                const parent = await this.parentOf(candidate.pid);
                if (parent !== candidate.parent || !await this.matches(candidate.parent)) continue;
                this.processes.push({ pid: candidate.pid, role: "descendant", home: this.home, started });
                log(join(this.run, "pids.ndjson"), { type: "discovered", ...candidate, home: this.home });
                changed = true;
            }
        }
    }

    private async inspect(pid: number): Promise<string> {
        const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "pid="], { stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code === 0) return out.trim();
        if (code === 1 && out.trim() === "" && err.trim() === "") return "";
        throw new Error(`Could not inspect PID ${pid}: ${err.trim() || `ps exited ${code}`}`);
    }

    private async parentOf(pid: number): Promise<number | undefined> {
        const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "ppid="], { stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code === 1 && out.trim() === "" && err.trim() === "") return undefined;
        if (code !== 0 || !/^\d+$/.test(out.trim())) throw new Error(`Cannot inspect parent of PID ${pid}`);
        return Number(out.trim());
    }

    private async matches(pid: number): Promise<boolean> {
        const owned = this.processes.find((entry) => entry.pid === pid);
        if (owned === undefined || (owned.child !== undefined && owned.child.exitCode !== null)) return false;
        const started = processStart(pid);
        if (started === undefined) return false;
        if (owned.started === null) throw new Error(`Cannot verify start identity of PID ${pid}`);
        return started === owned.started;
    }

    identities(): ProcessIdentity[] {
        const identities = this.processes.map(({ pid, started }) => ({ pid, started }));
        for (const pid of this.recordedWorkers) {
            if (!identities.some((entry) => entry.pid === pid)) identities.push({ pid, started: null });
        }
        return identities;
    }

    async killWorker(pid: number): Promise<void> {
        await this.discoverDescendants();
        if (!this.processes.some((process) => process.pid === pid && process.role === "descendant") || !await this.matches(pid)) {
            throw new Error(`Session process ${pid} does not belong to this trial`);
        }
        const commandLine = await command(["/bin/ps", "-p", String(pid), "-o", "command="]);
        if (!commandLine.includes(REPO) || !commandLine.includes(this.home) || !this.home.includes("/vera-dev/")
            || !commandLine.includes("--worker-index") || !await this.matches(pid)) {
            throw new Error(`Session process ${pid} cannot be verified for this trial`);
        }
        process.kill(pid, "SIGKILL");
        log(join(this.run, "pids.ndjson"), { type: "signal", pid, signal: "SIGKILL" });
    }

    async stopHost(): Promise<StopMeasurement> {
        await this.discoverDescendants();
        const host = this.processes.find((process) => process.role === "host");
        const workers = await readRecordedWorkers(this.home);
        for (const worker of workers) this.recordedWorkers.add(worker.pid);
        const pids = [...new Set([...(host === undefined ? [] : [host.pid]), ...workers.map((worker) => worker.pid)])];
        const started = performance.now();
        const startedWall = Date.now();
        const cli = this.start("stop", join(REPO, "clients/cli/main.ts"), {}, undefined, ["host", "stop", "--yes"]);
        const deadline = started + 180_000;
        let remaining = pids;
        while (performance.now() < deadline) {
            for (const worker of await readRecordedWorkers(this.home)) {
                this.recordedWorkers.add(worker.pid);
                if (!pids.includes(worker.pid)) pids.push(worker.pid);
            }
            const alive = await Promise.all(pids.map(async (pid) => (await this.inspect(pid)) !== ""));
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
        for (const owned of this.processes) {
            if (owned.child !== undefined && owned.child.exitCode !== null) continue;
            if (await this.inspect(owned.pid)) survivors.push(owned.pid);
        }
        for (const worker of await readRecordedWorkers(this.home)) this.recordedWorkers.add(worker.pid);
        for (const pid of this.recordedWorkers) {
            if (!survivors.includes(pid) && await this.inspect(pid)) survivors.push(pid);
        }
        log(join(this.run, "pids.ndjson"), { type: "cleanup", survivors });
        if (survivors.length) throw new Error(`Trial processes survived cleanup: ${survivors.join(", ")}`);
    }
}
