import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    clearBootFailures,
    countsAsBootFailure,
    findOrStartResidentHost,
    HOST_STARTUP_RACE_EXIT_CODE,
    HostBootLoopError,
    recentBootFailures,
} from "../../clients/host/launch.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";
import { VERA_RUNTIME_DIR_ENV } from "../../src/profile-paths.ts";

const previousRuntimeDir = process.env[VERA_RUNTIME_DIR_ENV];
const roots: string[] = [];

afterEach(() => {
    if (previousRuntimeDir === undefined) {
        delete process.env[VERA_RUNTIME_DIR_ENV];
    } else {
        process.env[VERA_RUNTIME_DIR_ENV] = previousRuntimeDir;
    }
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function useTemporaryRuntime(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-backoff-"));
    roots.push(root);
    process.env[VERA_RUNTIME_DIR_ENV] = root;
    return root;
}

const noHostLockfile = {
    publish(): Promise<HostLockRecord> {
        throw new Error("not used");
    },
    async read(): Promise<HostLockRecord | undefined> {
        return undefined;
    },
};

test("two recent boot deaths stop the respawn and name vera rescue", async () => {
    const root = useTemporaryRuntime();
    writeFileSync(
        join(root, "host-boot-failures.json"),
        `${JSON.stringify([Date.now() - 1_000, Date.now() - 500])}\n`,
    );
    const attempt = findOrStartResidentHost({
        lockfile: noHostLockfile,
        startupTimeoutMs: 200,
    });
    await expect(attempt).rejects.toBeInstanceOf(HostBootLoopError);
    await expect(attempt).rejects.toThrow("vera rescue");
});

test("boot deaths outside the window do not count against the limit", () => {
    const root = useTemporaryRuntime();
    const now = Date.now();
    writeFileSync(
        join(root, "host-boot-failures.json"),
        `${JSON.stringify([now - 120_000, now - 90_000, now - 1_000])}\n`,
    );
    expect(recentBootFailures(now)).toEqual([now - 1_000]);
});

test("a malformed failure record reads as no failures", () => {
    const root = useTemporaryRuntime();
    writeFileSync(join(root, "host-boot-failures.json"), "not json");
    expect(recentBootFailures(Date.now())).toEqual([]);
});

test("losing the startup race is not counted as a broken build", () => {
    // Another host winning the claim is a working outcome for the user, so a
    // shell alias that starts two Veras at once must not lock out spawning.
    expect(countsAsBootFailure(HOST_STARTUP_RACE_EXIT_CODE, 100)).toBe(false);
    expect(countsAsBootFailure(1, 100)).toBe(true);
    expect(countsAsBootFailure(0, 100)).toBe(false);
    // A death long after boot is a host that ran, not one that never came up.
    expect(countsAsBootFailure(1, 120_000)).toBe(false);
    // A signal death during boot still counts.
    expect(countsAsBootFailure(null, 100)).toBe(true);
});

test("a clean boot clears the failure record", () => {
    const root = useTemporaryRuntime();
    const path = join(root, "host-boot-failures.json");
    writeFileSync(path, `${JSON.stringify([Date.now()])}\n`);
    clearBootFailures();
    expect(existsSync(path)).toBe(false);
});
