import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertTrialHome, command, log, REPO } from "./common.ts";

interface OwnedProcess {
    pid: number;
    role: string;
    home: string;
    child?: ReturnType<typeof Bun.spawn>;
}

export class ProcessOwner {
    readonly processes: OwnedProcess[] = [];
    constructor(readonly run: string, readonly home: string) { assertTrialHome(home); }

    start(role: string, script: string, extra: Record<string, string> = {}, preload?: string) {
        const env: Record<string, string> = {
            PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp",
            LANG: "en_US.UTF-8", VERA_HOME: this.home,
            VERA_DEV_INSTANCE: "1", LOAD_RUN: this.run,
            ...extra,
        };
        const child = Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), script], {
            cwd: this.run, env,
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

    async stop(): Promise<void> {
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
