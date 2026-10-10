import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import type { OwnedSidecarContribution } from "../../src/extensions/contribution-set.ts";
import {
    LOG_RETENTION_MS,
    logMaxAgeMs,
    openSidecarLogPaths,
    pruneLogs,
} from "../../src/host/log-retention.ts";
import { startSidecarRuntime } from "../../src/host/sidecar-runtime.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

async function homeRuntime(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vera-log-retention-"));
    roots.push(root);
    return join(root, ".vera", "runtime");
}

async function writeAged(path: string, ageMs: number, body = "crow ahoy\n"): Promise<void> {
    await writeFile(path, body);
    const when = new Date(NOW.getTime() - ageMs);
    await utimes(path, when, when);
}

async function ageDirectory(path: string, ageMs: number): Promise<void> {
    const when = new Date(NOW.getTime() - ageMs);
    await utimes(path, when, when);
}

test("removes week-old logs and emptied directories, keeps fresh logs and sessions", async () => {
    const runtime = await homeRuntime();
    const logs = join(runtime, "logs");
    const sessions = join(runtime, "sessions");
    const staleWorkspace = join(logs, "-Users-crow-ship");
    const liveWorkspace = join(logs, "-Users-crow-deck");
    const captures = join(logs, "captures");
    await mkdir(staleWorkspace, { recursive: true });
    await mkdir(liveWorkspace, { recursive: true });
    await mkdir(captures, { recursive: true });
    await mkdir(sessions, { recursive: true });

    await writeAged(join(staleWorkspace, "plunder.jsonl"), 9 * DAY_MS, "x".repeat(100));
    await writeAged(join(liveWorkspace, "old-voyage.jsonl"), 8 * DAY_MS, "y".repeat(50));
    await writeAged(join(liveWorkspace, "today.jsonl"), DAY_MS);
    await writeAged(join(captures, "failed-request.json"), 30 * DAY_MS, "z".repeat(10));
    await writeAged(join(logs, "vera.log"), 60 * DAY_MS, "w".repeat(5));
    await writeAged(join(logs, "host.jsonl"), 60_000);
    await writeAged(join(logs, "launchd.out.log"), 60 * DAY_MS);
    await writeAged(join(sessions, "ancient.jsonl"), 90 * DAY_MS);
    await ageDirectory(staleWorkspace, 9 * DAY_MS);
    await ageDirectory(captures, 30 * DAY_MS);

    const result = await pruneLogs(logs, { now: NOW });

    expect(result).toEqual({ removedFiles: 4, removedBytes: 165 });
    expect(existsSync(staleWorkspace)).toBe(false);
    expect(existsSync(captures)).toBe(false);
    expect(existsSync(join(liveWorkspace, "old-voyage.jsonl"))).toBe(false);
    expect(existsSync(join(liveWorkspace, "today.jsonl"))).toBe(true);
    expect(existsSync(join(logs, "vera.log"))).toBe(false);
    expect(existsSync(join(logs, "host.jsonl"))).toBe(true);
    expect(existsSync(join(logs, "launchd.out.log"))).toBe(true);
    expect(existsSync(logs)).toBe(true);
    expect(existsSync(join(sessions, "ancient.jsonl"))).toBe(true);
});

test("keeps an empty directory created inside the retention window", async () => {
    const runtime = await homeRuntime();
    const logs = join(runtime, "logs");
    const freshWorkspace = join(logs, "-Users-crow-crowsnest");
    await mkdir(freshWorkspace, { recursive: true });

    await pruneLogs(logs, { now: NOW });

    expect(existsSync(freshWorkspace)).toBe(true);
});

test("a file just inside the window survives", async () => {
    const runtime = await homeRuntime();
    const logs = join(runtime, "logs");
    await mkdir(logs, { recursive: true });
    await writeAged(join(logs, "edge.jsonl"), LOG_RETENTION_MS - 60_000);

    const result = await pruneLogs(logs, { now: NOW });

    expect(result.removedFiles).toBe(0);
    expect(existsSync(join(logs, "edge.jsonl"))).toBe(true);
});

test("a missing logs directory is not an error", async () => {
    const runtime = await homeRuntime();

    const result = await pruneLogs(join(runtime, "logs"), { now: NOW });

    expect(result).toEqual({ removedFiles: 0, removedBytes: 0 });
});

test("the configured log max age decides what is pruned", async () => {
    const runtime = await homeRuntime();
    const home = join(runtime, "..");
    const logs = join(runtime, "logs");
    await mkdir(logs, { recursive: true });
    const configPath = join(home, "config.json");
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
        log_max_age_days: 30,
    }));
    await writeAged(join(logs, "three-weeks.jsonl"), 21 * DAY_MS);
    await writeAged(join(logs, "five-weeks.jsonl"), 35 * DAY_MS);

    const maxAgeMs = logMaxAgeMs(loadVeraConfig({ path: configPath }));
    const result = await pruneLogs(logs, { now: NOW, maxAgeMs });

    expect(maxAgeMs).toBe(30 * DAY_MS);
    expect(result.removedFiles).toBe(1);
    expect(existsSync(join(logs, "three-weeks.jsonl"))).toBe(true);
    expect(existsSync(join(logs, "five-weeks.jsonl"))).toBe(false);
});

test("an absent log max age keeps the built-in week", async () => {
    const runtime = await homeRuntime();
    const home = join(runtime, "..");
    await mkdir(home, { recursive: true });
    const configPath = join(home, "config.json");
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        model: "anthropic/example-model",
    }));

    expect(logMaxAgeMs(loadVeraConfig({ path: configPath }))).toBe(LOG_RETENTION_MS);
});

function sidecar(
    localId: string,
    directory: string,
    command: readonly string[],
    restart: boolean,
): OwnedSidecarContribution {
    return {
        id: `crow.ship/${localId}`,
        localId,
        extensionId: "crow.ship",
        extensionDirectory: directory,
        definition: { id: localId, command, env: {}, restart },
    };
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("condition did not hold in time");
        await Bun.sleep(10);
    }
}

test("an old log of a running sidecar is kept and a stopped sidecar's is deleted", async () => {
    const runtime = await homeRuntime();
    const logs = join(runtime, "logs");
    const sidecarLogs = join(logs, "sidecars");
    await mkdir(sidecarLogs, { recursive: true });
    const sidecars = startSidecarRuntime({
        sidecars: [
            sidecar("lookout", runtime, ["sleep", "30"], true),
            sidecar("deckhand", runtime, ["true"], false),
        ],
        socketPath: join(runtime, "host.sock"),
        logDirectory: sidecarLogs,
    });
    try {
        const state = (id: string) =>
            sidecars.statuses().find((status) => status.sidecarId === id)?.state;
        await until(() =>
            state("crow.ship/lookout") === "running"
            && state("crow.ship/deckhand") === "stopped");
        const running = join(sidecarLogs, "crow.ship.lookout.log");
        const stopped = join(sidecarLogs, "crow.ship.deckhand.log");
        const old = new Date(Date.now() - 30 * DAY_MS);
        await utimes(running, old, old);
        await utimes(stopped, old, old);

        const result = await pruneLogs(logs, {
            keep: (path) => openSidecarLogPaths(sidecars.statuses()).has(path),
        });

        expect(result.removedFiles).toBe(1);
        expect(existsSync(running)).toBe(true);
        expect(existsSync(stopped)).toBe(false);
    } finally {
        await sidecars.close();
    }
});
