#!/usr/bin/env bun

import { join } from "node:path";

import {
    homeIsDefault,
    listDevInstances,
    type DevInstanceRecord,
} from "../src/dev-instances.ts";
import {
    checkListedProcess,
    claimListedProcess,
    dropLiveProcessIn,
    listLiveProcessesIn,
    signalListedProcess,
    type ListedProcess,
    type LiveProcessReads,
    type LiveProcessRecord,
} from "../src/live-process.ts";
import { processIsAlive } from "../src/host/process-identity.ts";
import { readRecordedWorkers } from "../src/host/pool/worker-records.ts";

const DEFAULT_MAX_AGE_DAYS = 2;
const SIGTERM_GRACE_MS = 3_000;

export interface SweepRequest {
    readonly maxAgeMs: number;
    readonly dryRun: boolean;
    readonly root?: string;
}

export function parseSweepArgs(argv: readonly string[]): SweepRequest | string {
    let days = DEFAULT_MAX_AGE_DAYS;
    let dryRun = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dry-run") {
            dryRun = true;
            continue;
        }
        if (arg === "--days") {
            const raw = argv[++i];
            const parsed = raw === undefined ? Number.NaN : Number(raw);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return `invalid --days: ${raw ?? "(missing)"}`;
            }
            days = parsed;
            continue;
        }
        return `unknown argument: ${arg}`;
    }
    return { maxAgeMs: days * 24 * 60 * 60 * 1_000, dryRun };
}

function ageMs(record: LiveProcessRecord, now: number): number {
    const started = Date.parse(record.started_at);
    return Number.isNaN(started) ? 0 : now - started;
}

function formatAge(milliseconds: number): string {
    const hours = Math.floor(milliseconds / 3_600_000);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

interface SweepSeams {
    readonly reads?: LiveProcessReads;
    readonly graceMs?: number;
    readonly readProcessGroupSnapshot?: LiveProcessReads["readProcessGroupSnapshot"];
}

type StopOutcome =
    | { readonly kind: "stopped"; readonly note?: string }
    | { readonly kind: "gone" }
    | { readonly kind: "survived" }
    // A signal went out but the exit could not be confirmed.
    | { readonly kind: "unconfirmed" }
    | {
        readonly kind: "skipped";
        readonly reason: "replaced" | "unverified";
        // The listed process was seen to be gone, so its row is stale.
        readonly dropRow: boolean;
    };

const NOT_SIGNALLED_NOTES = {
    replaced: "another process now holds this PID; not signalled",
    unverified: "could not confirm it is still the listed process; not signalled",
} as const;

// After a signal, "replaced" may be the dying process itself, not a new one.
const SIGNALLED_REPLACED_NOTE =
    "signalled; the PID no longer belongs to the listed process";
const SIGNALLED_UNCONFIRMED_NOTE = "signalled; could not confirm it exited";

// Identity is checked before SIGTERM and again before each SIGKILL, because a
// PID can be reused during the wait. The wait polls liveness only.
async function stopProcess(
    listed: ListedProcess,
    seams: SweepSeams,
): Promise<StopOutcome> {
    const pid = listed.record.pid;
    const reads: LiveProcessReads = {
        ...seams.reads,
        ...(seams.readProcessGroupSnapshot === undefined ? {} : { readProcessGroupSnapshot: seams.readProcessGroupSnapshot }),
    };
    const isAlive = reads.isAlive ?? processIsAlive;
    const first = signalListedProcess(listed, "SIGTERM", { reads });
    if (first === "gone") return { kind: "gone" };
    if (first === "replaced" || first === "unverified") {
        return { kind: "skipped", reason: first, dropRow: first === "replaced" };
    }
    let signalled = first === "sent";
    const deadline = Date.now() + (seams.graceMs ?? SIGTERM_GRACE_MS);
    while (isAlive(pid) && Date.now() < deadline) {
        await Bun.sleep(100);
    }
    if (!isAlive(pid)) return { kind: "stopped" };
    for (const group of [true, false]) {
        const result = signalListedProcess(listed, "SIGKILL", { group, reads });
        if (result === "sent") signalled = true;
        if (result === "gone") return { kind: "stopped" };
        if (result === "replaced") {
            return signalled
                ? { kind: "stopped", note: SIGNALLED_REPLACED_NOTE }
                : { kind: "skipped", reason: "replaced", dropRow: true };
        }
        if (result === "unverified") {
            return signalled
                ? { kind: "unconfirmed" }
                : { kind: "skipped", reason: "unverified", dropRow: false };
        }
    }
    await Bun.sleep(100);
    // Only a process seen to be gone or replaced counts as stopped.
    const state = checkListedProcess(listed, reads);
    if (state === "same") return { kind: "survived" };
    if (state === "unverified") {
        return signalled
            ? { kind: "unconfirmed" }
            : { kind: "skipped", reason: "unverified", dropRow: false };
    }
    return state === "replaced" && signalled
        ? { kind: "stopped", note: SIGNALLED_REPLACED_NOTE }
        : { kind: "stopped" };
}

export async function sweepDevInstances(
    request: SweepRequest,
    write: (line: string) => void,
    seams: SweepSeams = {},
): Promise<number> {
    const instances = listDevInstances(request.root).filter(
        (instance) => !homeIsDefault(instance.home, request.root),
    );
    if (instances.length === 0) {
        write("No development instances are registered.\n");
        return 0;
    }
    const now = Date.now();
    let stopped = 0;
    let kept = 0;
    // Every instance is listed and claimed before the first signal, so a PID
    // reused while earlier processes shut down is not taken for a listed one.
    const batches: {
        readonly instance: DevInstanceRecord;
        readonly stale: readonly ListedProcess[];
    }[] = [];
    for (const instance of instances) {
        const live = listLiveProcessesIn(instance.home);
        const workers = await readRecordedWorkers(instance.home);
        const known = new Set(live.map((record) => record.pid));
        const combined: LiveProcessRecord[] = [...live, ...workers.filter((worker) => !known.has(worker.pid)).map((worker) => ({
            schema_version: 1 as const, pid: worker.pid, kind: "worker" as const,
            started_at: worker.started_at, runtime_dir: join(instance.home, "runtime"),
        }))];
        const staleHosts = new Set(live.filter((record) => record.kind === "host"
            && ageMs(record, now) >= request.maxAgeMs).map((record) => record.pid));
        // At the boundary the process goes, so --days 0 means everything.
        const stale = combined.filter((record) => ageMs(record, now) >= request.maxAgeMs
            || workers.some((worker) => worker.pid === record.pid && worker.hostPid !== undefined
                && staleHosts.has(worker.hostPid)));
        kept += combined.length - stale.length;
        if (stale.length === 0) continue;
        batches.push({
            instance,
            stale: stale.map((record) => claimListedProcess(record, seams.reads)),
        });
    }
    for (const { instance, stale } of batches) {
        write(`${describe(instance)}\n`);
        for (const listed of stale) {
            const record = listed.record;
            const age = formatAge(ageMs(record, now));
            const label = `${record.kind.padEnd(11)} pid ${record.pid}  ${age}`;
            if (request.dryRun) {
                write(`  would stop  ${label}\n`);
                continue;
            }
            const outcome = await stopProcess(listed, seams);
            switch (outcome.kind) {
                case "stopped":
                    dropLiveProcessIn(instance.home, record.pid);
                    stopped += 1;
                    write(`  stopped     ${label}${
                        outcome.note === undefined ? "" : `  (${outcome.note})`
                    }\n`);
                    break;
                case "gone":
                    dropLiveProcessIn(instance.home, record.pid);
                    write(`  gone        ${label}  (already exited)\n`);
                    break;
                case "survived":
                    write(`  would not die ${label}\n`);
                    break;
                case "unconfirmed":
                    write(`  unconfirmed ${label}  (${
                        SIGNALLED_UNCONFIRMED_NOTE
                    })\n`);
                    break;
                case "skipped":
                    if (outcome.dropRow) {
                        dropLiveProcessIn(instance.home, record.pid);
                    }
                    write(`  skipped     ${label}  (${
                        NOT_SIGNALLED_NOTES[outcome.reason]
                    })\n`);
                    break;
            }
        }
    }
    const listed = plural(instances.length, "instance");
    write(
        request.dryRun
            ? `\n${listed} listed, ${
                plural(kept, "process", "processes")
            } younger than the cutoff.\n`
            : `\nStopped ${
                plural(stopped, "process", "processes")
            } across ${listed}, left ${kept} running.\n`,
    );
    return 0;
}

function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

function describe(instance: DevInstanceRecord): string {
    const build = instance.build_id === undefined ? "" : `  ${instance.build_id}`;
    return `${instance.home}${build}`;
}

if (import.meta.main) {
    const request = parseSweepArgs(Bun.argv.slice(2));
    if (typeof request === "string") {
        process.stderr.write(
            `dev-sweep: ${request}\nusage: bun run dev:sweep [--days N] [--dry-run]\n`,
        );
        process.exit(1);
    }
    process.exit(
        await sweepDevInstances(request, (line) => process.stdout.write(line)),
    );
}
