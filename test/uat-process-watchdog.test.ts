import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processStartedAt } from "../src/host/process-identity.ts";

const WATCHDOG = join(import.meta.dir, "support", "uat-process-watchdog.ts");
const STALE_START = "2000-01-01T00:00:00.000Z";

interface Fixture {
    readonly directory: string;
    readonly binDirectory: string;
    readonly manifestPath: string;
    readonly lockPath: string;
}

function createFixture(): Fixture {
    const directory = mkdtempSync(join(tmpdir(), "vera-watchdog-test-"));
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    return {
        directory,
        binDirectory,
        manifestPath: join(directory, "manifest.json"),
        lockPath: join(directory, "host.json"),
    };
}

function spawnSleeper(): Bun.Subprocess {
    return Bun.spawn(["sleep", "300"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });
}

function startedAtIso(pid: number): string {
    const startedAt = processStartedAt(pid);
    if (startedAt === undefined) throw new Error(`no start time for ${pid}`);
    return new Date(startedAt).toISOString();
}

function writeManifest(
    fixture: Fixture,
    options: {
        readonly owner: Bun.Subprocess;
        readonly host: Bun.Subprocess;
        readonly hostStartedAt: string;
        readonly ownerStartedAt: string;
        readonly heartbeatTimeoutMs: number;
    },
): void {
    writeFileSync(fixture.lockPath, `${JSON.stringify({
        pid: options.host.pid,
        started_at: options.hostStartedAt,
    })}\n`);
    writeFileSync(fixture.manifestPath, `${JSON.stringify({
        schema_version: 2,
        heartbeat_timeout_ms: options.heartbeatTimeoutMs,
        owner: { pid: options.owner.pid, started_at: options.ownerStartedAt },
        resources: [{ kind: "host_lock", path: fixture.lockPath }],
    })}\n`);
}

function installPs(fixture: Fixture, body: string | undefined): void {
    if (body === undefined) return;
    const path = join(fixture.binDirectory, "ps");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
}

/** Runs the watchdog to completion; an empty bin directory means no `ps`. */
async function runWatchdog(
    fixture: Fixture,
    options: {
        readonly path: string;
        readonly lease: "closed" | "expired";
    },
): Promise<void> {
    const watchdog = Bun.spawn([process.execPath, WATCHDOG, fixture.manifestPath], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        env: { PATH: options.path },
    });
    try {
        if (options.lease === "closed") await watchdog.stdin.end();
        const finished = await Promise.race([
            watchdog.exited.then(() => true),
            Bun.sleep(20_000).then(() => false),
        ]);
        expect(finished).toBe(true);
    } finally {
        watchdog.kill("SIGKILL");
        await watchdog.exited;
    }
}

async function stillRunning(child: Bun.Subprocess): Promise<boolean> {
    return await Promise.race([
        child.exited.then(() => false),
        Bun.sleep(300).then(() => true),
    ]);
}

async function reap(...children: Bun.Subprocess[]): Promise<void> {
    for (const child of children) {
        child.kill("SIGKILL");
        await child.exited;
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
}

function cleanup(fixture: Fixture): void {
    rmSync(fixture.directory, { recursive: true, force: true });
}

test.concurrent("the watchdog leaves a live pid alone when ps is unavailable", async () => {
    const fixture = createFixture();
    const owner = spawnSleeper();
    const host = spawnSleeper();
    try {
        writeManifest(fixture, {
            owner,
            host,
            hostStartedAt: STALE_START,
            ownerStartedAt: startedAtIso(owner.pid),
            heartbeatTimeoutMs: 60_000,
        });
        await runWatchdog(fixture, { path: fixture.binDirectory, lease: "closed" });
        expect(await stillRunning(host)).toBe(true);
    } finally {
        await reap(host, owner);
        cleanup(fixture);
    }
}, 30_000);

test.concurrent("the watchdog leaves a live pid alone when ps output is unparseable", async () => {
    const fixture = createFixture();
    const owner = spawnSleeper();
    const host = spawnSleeper();
    try {
        installPs(fixture, 'echo "not an elapsed time"');
        writeManifest(fixture, {
            owner,
            host,
            hostStartedAt: STALE_START,
            ownerStartedAt: startedAtIso(owner.pid),
            heartbeatTimeoutMs: 60_000,
        });
        await runWatchdog(fixture, { path: fixture.binDirectory, lease: "closed" });
        expect(await stillRunning(host)).toBe(true);
    } finally {
        await reap(host, owner);
        cleanup(fixture);
    }
}, 30_000);

test.concurrent("the watchdog leaves a live pid alone when its start time differs", async () => {
    const fixture = createFixture();
    const owner = spawnSleeper();
    const host = spawnSleeper();
    try {
        writeManifest(fixture, {
            owner,
            host,
            hostStartedAt: STALE_START,
            ownerStartedAt: startedAtIso(owner.pid),
            heartbeatTimeoutMs: 60_000,
        });
        await runWatchdog(fixture, {
            path: process.env.PATH ?? "/usr/bin:/bin",
            lease: "closed",
        });
        expect(await stillRunning(host)).toBe(true);
    } finally {
        await reap(host, owner);
        cleanup(fixture);
    }
}, 30_000);

test.concurrent("an expired controller is left alone when ps is unavailable", async () => {
    const fixture = createFixture();
    const owner = spawnSleeper();
    const host = spawnSleeper();
    try {
        writeManifest(fixture, {
            owner,
            host,
            hostStartedAt: startedAtIso(host.pid),
            ownerStartedAt: STALE_START,
            heartbeatTimeoutMs: 300,
        });
        await runWatchdog(fixture, { path: fixture.binDirectory, lease: "expired" });
        expect(await stillRunning(owner)).toBe(true);
    } finally {
        await reap(host, owner);
        cleanup(fixture);
    }
}, 30_000);

test.concurrent("the watchdog still stops a pid whose start time it measured", async () => {
    const fixture = createFixture();
    const owner = spawnSleeper();
    const host = spawnSleeper();
    try {
        writeManifest(fixture, {
            owner,
            host,
            hostStartedAt: startedAtIso(host.pid),
            ownerStartedAt: startedAtIso(owner.pid),
            heartbeatTimeoutMs: 60_000,
        });
        await runWatchdog(fixture, {
            path: process.env.PATH ?? "/usr/bin:/bin",
            lease: "closed",
        });
        expect(await stillRunning(host)).toBe(false);
        expect(host.signalCode).toBe("SIGTERM");
        expect(existsSync(fixture.manifestPath)).toBe(false);
    } finally {
        await reap(host, owner);
        cleanup(fixture);
    }
}, 30_000);
