import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSweepArgs, sweepDevInstances } from "../../scripts/dev-sweep.ts";
import { registerDevInstance } from "../../src/dev-instances.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { listLiveProcessesIn, postLiveProcess } from "../../src/live-process.ts";

const temporaryDirectories: string[] = [];
const spawned: number[] = [];

afterAll(() => {
    for (const pid of spawned) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already stopped by the sweep under test.
        }
    }
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/** A real process, so the sweep signals something that can refuse to die. */
function longRunningProcess(): number {
    const child = Bun.spawn(["sleep", "300"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    child.unref();
    spawned.push(child.pid);
    return child.pid;
}

function instanceWithOneProcess(root: string): {
    readonly veraHome: string;
    readonly pid: number;
} {
    const parent = tempDir("vera-sweep-");
    const veraHome = join(parent, ".vera");
    mkdirSync(veraHome, { recursive: true });
    const pid = longRunningProcess();
    postLiveProcess("host", {
        home: parent,
        pid,
        startedAt: new Date().toISOString(),
        runtimeDir: join(veraHome, "runtime"),
    });
    registerDevInstance({
        source: fileURLToPath(import.meta.url),
        home: veraHome,
        root,
    });
    return { veraHome, pid };
}

async function sweep(
    request: Parameters<typeof sweepDevInstances>[0],
): Promise<string> {
    let written = "";
    const code = await sweepDevInstances(request, (line) => {
        written += line;
    });
    expect(code).toBe(0);
    return written;
}

test("--days and --dry-run are read, anything else is refused", () => {
    expect(parseSweepArgs([])).toEqual({
        maxAgeMs: 2 * 24 * 60 * 60 * 1_000,
        dryRun: false,
    });
    expect(parseSweepArgs(["--dry-run", "--days", "5"])).toEqual({
        maxAgeMs: 5 * 24 * 60 * 60 * 1_000,
        dryRun: true,
    });
    expect(parseSweepArgs(["--days"])).toBe("invalid --days: (missing)");
    expect(parseSweepArgs(["--days", "-1"])).toBe("invalid --days: -1");
    expect(parseSweepArgs(["--weeks"])).toBe("unknown argument: --weeks");
});

test("an empty registry is said out loud, not swept in silence", async () => {
    const root = tempDir("vera-sweep-root-");
    const written = await sweep({ maxAgeMs: 0, dryRun: false, root });
    expect(written).toContain("No development instances are registered.");
});

test("a process younger than the cutoff is left running", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);

    const written = await sweep({
        maxAgeMs: 2 * 24 * 60 * 60 * 1_000,
        dryRun: false,
        root,
    });

    expect(written).not.toContain(String(instance.pid));
    expect(written).toContain("Stopped 0 processes across 1 instance,");
    expect(processIsAlive(instance.pid)).toBe(true);
    expect(listLiveProcessesIn(instance.veraHome)).toHaveLength(1);
});

test("a dry run names what it would stop and stops nothing", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);

    const written = await sweep({ maxAgeMs: 0, dryRun: true, root });

    expect(written).toContain(instance.veraHome);
    expect(written).toContain(`would stop`);
    expect(written).toContain(String(instance.pid));
    expect(processIsAlive(instance.pid)).toBe(true);
    expect(listLiveProcessesIn(instance.veraHome)).toHaveLength(1);
});

test("a process past the cutoff is stopped and its record cleared", async () => {
    const root = tempDir("vera-sweep-root-");
    const instance = instanceWithOneProcess(root);

    const written = await sweep({ maxAgeMs: 0, dryRun: false, root });

    expect(written).toContain(instance.veraHome);
    expect(written).toContain(`stopped`);
    expect(written).toContain("Stopped 1 process across 1 instance,");
    expect(processIsAlive(instance.pid)).toBe(false);
    expect(listLiveProcessesIn(instance.veraHome)).toEqual([]);
});

test("the sweep reaches every registered home, not just the first", async () => {
    const root = tempDir("vera-sweep-root-");
    const first = instanceWithOneProcess(root);
    const second = instanceWithOneProcess(root);

    await sweep({ maxAgeMs: 0, dryRun: false, root });

    expect(processIsAlive(first.pid)).toBe(false);
    expect(processIsAlive(second.pid)).toBe(false);
});
