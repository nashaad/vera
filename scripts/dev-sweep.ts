#!/usr/bin/env bun

import { listDevInstances, type DevInstanceRecord } from "../src/dev-instances.ts";
import {
    dropLiveProcessIn,
    listLiveProcessesIn,
    type LiveProcessRecord,
} from "../src/live-process.ts";
import { processIsAlive } from "../src/host/process-identity.ts";

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

async function stopProcess(pid: number): Promise<boolean> {
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        return !processIsAlive(pid);
    }
    const deadline = Date.now() + SIGTERM_GRACE_MS;
    while (processIsAlive(pid) && Date.now() < deadline) {
        await Bun.sleep(100);
    }
    if (!processIsAlive(pid)) return true;
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        // A process that leads no group is killed on its own below.
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // Already gone between the check and the signal.
    }
    await Bun.sleep(100);
    return !processIsAlive(pid);
}

export async function sweepDevInstances(
    request: SweepRequest,
    write: (line: string) => void,
): Promise<number> {
    const instances = listDevInstances(request.root);
    if (instances.length === 0) {
        write("No development instances are registered.\n");
        return 0;
    }
    const now = Date.now();
    let stopped = 0;
    let kept = 0;
    for (const instance of instances) {
        const live = listLiveProcessesIn(instance.home);
        // At the boundary the process goes, so --days 0 means everything.
        const stale = live.filter((record) =>
            ageMs(record, now) >= request.maxAgeMs
        );
        kept += live.length - stale.length;
        if (stale.length === 0) continue;
        write(`${describe(instance)}\n`);
        for (const record of stale) {
            const age = formatAge(ageMs(record, now));
            if (request.dryRun) {
                write(`  would stop  ${record.kind.padEnd(11)} pid ${record.pid}  ${age}\n`);
                continue;
            }
            const gone = await stopProcess(record.pid);
            if (gone) {
                dropLiveProcessIn(instance.home, record.pid);
                stopped += 1;
            }
            write(
                `  ${gone ? "stopped    " : "would not die"} ${
                    record.kind.padEnd(11)
                } pid ${record.pid}  ${age}\n`,
            );
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
