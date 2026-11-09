import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HOST_STARTUP_RACE_EXIT_CODE } from "../../src/host/lockfile.ts";
import { veraRuntimeDirectory } from "../../src/profile-paths.ts";

const BOOT_FAILURE_WINDOW_MS = 30_000;
export const BOOT_FAILURE_LIMIT = 2;

export { HOST_STARTUP_RACE_EXIT_CODE };

export class HostBootLoopError extends Error {
    constructor(count: number) {
        super(
            `The resident host exited during startup ${count} times in a row;`
                + " not respawning it. Fix the host build, then retry."
                + " Run 'vera host stop --force' after you fix the build.",
        );
        this.name = "HostBootLoopError";
    }
}

export function countsAsBootFailure(
    code: number | null,
    elapsedMs: number,
): boolean {
    if (code === 0 || code === HOST_STARTUP_RACE_EXIT_CODE) return false;
    return elapsedMs <= BOOT_FAILURE_WINDOW_MS;
}

function bootFailuresPath(): string {
    return join(veraRuntimeDirectory(), "host-boot-failures.json");
}

export function recentBootFailures(nowMs: number): number[] {
    let timestamps: unknown;
    try {
        timestamps = JSON.parse(readFileSync(bootFailuresPath(), "utf8"));
    } catch {
        return [];
    }
    if (!Array.isArray(timestamps)) return [];
    return timestamps.filter((value): value is number =>
        typeof value === "number" && nowMs - value <= BOOT_FAILURE_WINDOW_MS
    );
}

export function recordBootFailure(nowMs: number): void {
    try {
        const path = bootFailuresPath();
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(
            temporary,
            `${JSON.stringify([...recentBootFailures(nowMs), nowMs])}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        renameSync(temporary, path);
    } catch {
    }
}

export function clearBootFailures(): void {
    try {
        unlinkSync(bootFailuresPath());
    } catch {
    }
}
