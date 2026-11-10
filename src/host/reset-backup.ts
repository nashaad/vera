import { existsSync, mkdirSync } from "node:fs";
import { chmod, copyFile, cp, open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { annexPortPath } from "./annex-port.ts";
import { liveProcessDirectoryIn } from "../live-process.ts";
import { veraRuntimeDirectoryIn } from "../profile-paths.ts";
import { defaultHostLockPath } from "./lockfile.ts";
import type { ResetCandidate, ResetDiscovery } from "./reset-discovery.ts";

// The host log is append-only and can grow without bound; the backup keeps only its end.
export const HOST_LOG_TAIL_BYTES = 256 * 1024;

export function resetBackupDirectory(home: string, now: Date): string {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    return join(veraRuntimeDirectoryIn(home), "backups", `reset-${stamp}`);
}

// Copies runtime records only. Sessions, config, inbox and schedules are never read here.
export async function backUpResetRecords(
    discovery: ResetDiscovery,
    candidates: readonly ResetCandidate[],
    now: Date,
): Promise<string> {
    let directory = resetBackupDirectory(discovery.home, now);
    for (let attempt = 2; existsSync(directory); attempt++) {
        directory = `${resetBackupDirectory(discovery.home, now)}-${attempt}`;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const runtime = discovery.runtime;
    await copyIfPresent(defaultHostLockPath(discovery.home), join(directory, "host.json"));
    await copyTreeIfPresent(join(runtime, "workers"), join(directory, "workers"));
    await copyTreeIfPresent(join(runtime, "relaunch"), join(directory, "relaunch"));
    await copyTreeIfPresent(join(runtime, "restarts"), join(directory, "restarts"));
    await copyIfPresent(annexPortPath(discovery.home), join(directory, "annex.json"));
    await copyTreeIfPresent(liveProcessDirectoryIn(discovery.home), join(directory, "live"));
    await copyLogTail(join(runtime, "logs", "host.jsonl"), join(directory, "logs", "host.jsonl"));
    await writeFile(join(directory, "processes.json"), `${JSON.stringify(processSnapshot(discovery, candidates), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    return directory;
}

function processSnapshot(discovery: ResetDiscovery, candidates: readonly ResetCandidate[]): object {
    return {
        home: discovery.home,
        candidates: candidates.map((candidate) => ({
            pid: candidate.pid,
            role: candidate.role,
            started_at: new Date(candidate.startedAt).toISOString(),
            proof: candidate.proof,
            recorded: candidate.recorded,
            build_id: candidate.build ?? null,
            command: candidate.command,
        })),
        unproven: discovery.unproven,
        records: discovery.records.map((record) => ({ pid: record.pid, started_at: record.startedAt, source: record.source })),
    };
}

async function copyIfPresent(source: string, target: string): Promise<void> {
    if (!existsSync(source)) return;
    await copyFile(source, target);
    await chmod(target, 0o600);
}

async function copyTreeIfPresent(source: string, target: string): Promise<void> {
    if (!existsSync(source)) return;
    await cp(source, target, { recursive: true, errorOnExist: false, force: true });
}

async function copyLogTail(source: string, target: string): Promise<void> {
    if (!existsSync(source)) return;
    const size = (await stat(source)).size;
    const start = Math.max(0, size - HOST_LOG_TAIL_BYTES);
    const handle = await open(source, "r");
    let bytes: Buffer;
    try {
        bytes = Buffer.alloc(size - start);
        await handle.read(bytes, 0, bytes.length, start);
    } finally {
        await handle.close();
    }
    let text = bytes.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
}
