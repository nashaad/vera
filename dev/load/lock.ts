import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneRetained, removeActive, RunArtifacts } from "./artifacts.ts";
import { processStart, type ProcessIdentity } from "./identity.ts";

interface LockRecord {
    readonly kind: "vera-load-lock";
    readonly version: 1;
    readonly runner: ProcessIdentity;
    readonly phase: "setup" | "running" | "stopped";
    readonly run?: string;
    readonly alias?: string;
    readonly children?: readonly ProcessIdentity[];
}

async function writeRecord(path: string, record: LockRecord): Promise<void> {
    const temporary = join(path, "owner.tmp");
    await writeFile(temporary, JSON.stringify(record));
    await rename(temporary, join(path, "owner.json"));
}

function validIdentity(value: unknown): value is ProcessIdentity {
    if (value === null || typeof value !== "object") return false;
    const identity = value as ProcessIdentity;
    return Number.isSafeInteger(identity.pid) && identity.pid > 0
        && (identity.started === null || (typeof identity.started === "string" && identity.started.length > 0));
}

async function recover(root: string): Promise<void> {
    const lock = join(root, "run.lock");
    const guard = join(root, "recovery.lock");
    try {
        await mkdir(guard);
    } catch {
        throw new Error(`Load recovery is already locked or requires inspection: ${guard}`);
    }
    try {
        let record: LockRecord;
        try {
            record = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as LockRecord;
        } catch {
            throw new Error(`Cannot verify load lock ownership: ${lock}`);
        }
        if (record.kind !== "vera-load-lock" || record.version !== 1 || !validIdentity(record.runner)
            || record.runner.started === null || !["setup", "running", "stopped"].includes(record.phase)) {
            throw new Error(`Invalid load lock ownership record: ${lock}`);
        }
        const actual = processStart(record.runner.pid);
        if (actual !== undefined) {
            const state = actual === record.runner.started ? "is active" : "has been reused";
            throw new Error(`Load runner PID ${record.runner.pid} ${state}; retaining ${lock}`);
        }
        if (record.phase === "running") {
            throw new Error(`Cannot prove the child inventory for ${record.run ?? lock} is complete. Inspect the run and its processes before removing the lock or scratch.`);
        }
        if (record.phase === "stopped") {
            if (!Array.isArray(record.children) || !record.children.every(validIdentity)) {
                throw new Error(`Cannot verify the stopped child inventory: ${lock}`);
            }
            for (const child of record.children) {
                if (processStart(child.pid) !== undefined) {
                    throw new Error(`Recorded child PID ${child.pid} is present or reused; retaining ${record.run ?? lock}`);
                }
            }
        }
        if (record.run === undefined || record.alias === undefined) {
            throw new Error(`No complete run ownership record in ${lock}; inspect the runner's scratch before removing it.`);
        }
        await RunArtifacts.recover(root, record.run, record.alias, record.runner.pid);
        const active = join(root, "active");
        await removeActive(active, record.run);
        await pruneRetained(root, record.run);
        await rm(lock, { recursive: true });
    } finally {
        await rm(guard, { recursive: true, force: true });
    }
}

export class RunLock {
    private constructor(readonly path: string, private record: LockRecord) {}

    static async acquire(root: string): Promise<RunLock> {
        const path = join(root, "run.lock");
        try {
            await mkdir(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await recover(root);
            await mkdir(path);
        }
        try {
            const started = processStart(process.pid);
            if (started === undefined) throw new Error(`Cannot identify load runner PID ${process.pid}`);
            const record: LockRecord = { kind: "vera-load-lock", version: 1, runner: { pid: process.pid, started }, phase: "setup" };
            await writeRecord(path, record);
            return new RunLock(path, record);
        } catch (error) {
            await rm(path, { recursive: true, force: true });
            throw error;
        }
    }

    private async update(record: LockRecord): Promise<void> {
        await writeRecord(this.path, record);
        this.record = record;
    }

    async register(artifacts: RunArtifacts): Promise<void> {
        await this.update({ ...this.record, run: artifacts.run, alias: artifacts.alias });
    }

    async running(): Promise<void> {
        await this.update({ ...this.record, phase: "running", children: undefined });
    }

    async setup(): Promise<void> {
        await this.update({ ...this.record, phase: "setup", children: undefined });
    }

    async stopped(children: readonly ProcessIdentity[]): Promise<void> {
        await this.update({ ...this.record, phase: "stopped", children });
    }

    async release(): Promise<void> {
        await rm(this.path, { recursive: true, force: true });
    }
}
