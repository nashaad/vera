import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostLifecyclePathIn } from "../../src/profile-paths.ts";
import { HostLifecycle } from "../../src/host/host-lifecycle.ts";
import { HOST_STARTUP_RACE_EXIT_CODE } from "../../src/host/lockfile.ts";
import { socketTest } from "../support/socket-probe.ts";

interface LifecycleRecord {
    readonly pid: number;
    readonly started_at: string;
    readonly build_id: string;
    readonly state: string;
    readonly stop_recorded: boolean;
}

test("abandoned atomic-write files are removed without touching a live writer", async () => {
    const home = await mkdtemp(join(tmpdir(), "hsold-"));
    const path = hostLifecyclePathIn(home);
    const child = Bun.spawn(["/bin/sleep", "0.01"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    const suffix = "00000000-0000-4000-8000-000000000000.tmp";
    const stale = `${path}.${child.pid}.${suffix}`;
    const live = `${path}.${process.pid}.${suffix}`;
    try {
        await mkdir(join(home, "runtime"));
        await writeFile(stale, "old");
        await writeFile(live, "active");
        new HostLifecycle(home, {
            pid: process.pid, started_at: new Date().toISOString(), build_id: "vera-test",
        }, () => true).start();
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(live)).toBe(true);
        expect((await stat(path)).size).toBe(2_048);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

for (const invalid of ["{", "x".repeat(2_049)]) {
    test("an invalid lifecycle record is reported and replaced", async () => {
        const home = await mkdtemp(join(tmpdir(), "hsbad-"));
        const path = hostLifecyclePathIn(home);
        const log: Record<string, unknown>[] = [];
        try {
            await mkdir(join(home, "runtime"));
            await writeFile(path, invalid);
            const lifecycle = new HostLifecycle(home, {
                pid: process.pid, started_at: new Date().toISOString(), build_id: "vera-test",
            }, (entry) => { log.push(entry); return true; });
            lifecycle.start();
            expect(log).toContainEqual(expect.objectContaining({ type: "host_lifecycle_failed" }));
            expect((await stat(path)).size).toBe(2_048);
            expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid, stop_recorded: false });
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
}

for (const role of ["host", "worker"] as const) {
    test(`a ${role} startup failure is recorded in its home`, async () => {
        const root = await mkdtemp(join(tmpdir(), "hsf-"));
        if (role === "host") await writeFile(join(root, "config.json"), "{");
        const entry = role === "host" ? "clients/host/main.ts" : "clients/host/session-worker.ts";
        const child = Bun.spawn([process.execPath, entry], {
            cwd: process.cwd(),
            env: { ...process.env, VERA_HOME: root, VERA_DEV_INSTANCE: "hoststop dev" },
            stdout: "ignore", stderr: "pipe",
        });
        try {
            const [code] = await Promise.all([child.exited, new Response(child.stderr).text()]);
            expect(code).not.toBe(0);
            const log = (await readFile(join(root, "runtime", "logs", "host.jsonl"), "utf8"))
                .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(log).toContainEqual(expect.objectContaining({
                type: "host_stopping", role, pid: child.pid,
                reason: role === "host" ? "startup_failure" : "exception",
            }));
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await child.exited;
            }
            await rm(root, { recursive: true, force: true });
        }
    });
}

socketTest("a new host reports an unrecorded exit and ignores a recorded stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "hsl-"));
    const home = join(root, "h");
    await mkdir(home);
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
        host: { workers: 0 },
    }));
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const errors: Promise<string>[] = [];
    const launch = () => {
        const child = Bun.spawn([process.execPath, "clients/host/main.ts", "--single-process", "--no-discovery"], {
            cwd: process.cwd(),
            env: { ...process.env, VERA_HOME: home, VERA_DEV_INSTANCE: "hoststop dev" },
            stdout: "ignore", stderr: "pipe",
        });
        children.push(child);
        errors.push(new Response(child.stderr).text());
        return child;
    };
    const waitForRecord = async (child: ReturnType<typeof launch>, state = "running"): Promise<LifecycleRecord> => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error("Host exited before recording startup.");
            const record = await readFile(hostLifecyclePathIn(home), "utf8")
                .then((data) => JSON.parse(data) as LifecycleRecord, () => undefined);
            if (record?.pid === child.pid && record.state === state) return record;
            await Bun.sleep(25);
        }
        throw new Error("Host did not record startup.");
    };
    const entries = async (): Promise<Record<string, unknown>[]> =>
        (await readFile(join(home, "runtime", "logs", "host.jsonl"), "utf8"))
            .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    try {
        const invalidWorker = join(home, "runtime", "workers", "w0.json");
        await mkdir(join(home, "runtime", "workers"), { recursive: true });
        await writeFile(invalidWorker, "{}");
        const failed = launch();
        expect(await failed.exited).not.toBe(0);
        expect(JSON.parse(await readFile(hostLifecyclePathIn(home), "utf8")))
            .toMatchObject({ pid: failed.pid, state: "stopping", stop_recorded: true });
        expect((await entries()).filter((entry) => entry.type === "host_stopping" && entry.pid === failed.pid))
            .toEqual([expect.objectContaining({ reason: "startup_failure" })]);
        await rm(invalidWorker);

        const paused = Bun.spawn([process.execPath, "-e", `
            import { startResidentHost } from ${JSON.stringify(join(process.cwd(), "src/host/runtime.ts"))};
            import { HostLifecycle } from ${JSON.stringify(join(process.cwd(), "src/host/host-lifecycle.ts"))};
            import { createHostLogWriter, defaultHostLogPath } from ${JSON.stringify(join(process.cwd(), "src/host/host-log.ts"))};
            import { thisProcessBuildId } from ${JSON.stringify(join(process.cwd(), "src/release/stamp.ts"))};
            const home = process.env.VERA_HOME;
            const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
            const identity = { pid: process.pid, started_at: startedAt, build_id: thisProcessBuildId() };
            const lifecycle = new HostLifecycle(home, identity, createHostLogWriter({ path: defaultHostLogPath(home) }));
            await startResidentHost({
                home, startedAt, processWorker: false,
                config: { schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto" },
                onHostClaimed: () => { lifecycle.start(); return new Promise(() => setInterval(() => {}, 1000)); },
            });
        `], {
            cwd: process.cwd(),
            env: { ...process.env, VERA_HOME: home, VERA_DEV_INSTANCE: "hoststop dev" },
            stdout: "ignore", stderr: "pipe",
        });
        children.push(paused);
        errors.push(new Response(paused.stderr).text());
        const pausedRecord = await waitForRecord(paused, "starting");
        paused.kill("SIGKILL");
        await paused.exited;

        const first = launch();
        const firstRecord = await waitForRecord(first);
        expect((await entries()).filter((entry) => entry.type === "previous_host_unclean")).toEqual([
            expect.objectContaining({
                pid: paused.pid, build_id: pausedRecord.build_id,
                started_at: pausedRecord.started_at, last_known_state: "starting",
            }),
        ]);
        expect(firstRecord).toMatchObject({ state: "running", stop_recorded: false });
        expect((await stat(hostLifecyclePathIn(home))).size).toBe(2_048);
        const rival = launch();
        expect(await rival.exited).toBe(HOST_STARTUP_RACE_EXIT_CODE);
        expect((await entries()).filter((entry) => entry.type === "host_stopping" && entry.pid === rival.pid))
            .toEqual([expect.objectContaining({ role: "host", reason: "startup_race" })]);
        expect(JSON.parse(await readFile(hostLifecyclePathIn(home), "utf8"))).toMatchObject(firstRecord);
        first.kill("SIGKILL");
        await first.exited;

        const second = launch();
        await waitForRecord(second);
        expect((await entries()).filter((entry) => entry.type === "previous_host_unclean")).toEqual([
            expect.objectContaining({ pid: paused.pid, last_known_state: "starting" }),
            expect.objectContaining({
                pid: first.pid, build_id: firstRecord.build_id,
                started_at: firstRecord.started_at, last_known_state: "running",
            }),
        ]);
        second.kill("SIGTERM");
        expect(await second.exited).toBe(0);
        const stopped = JSON.parse(await readFile(hostLifecyclePathIn(home), "utf8")) as LifecycleRecord;
        expect(stopped).toMatchObject({ pid: second.pid, state: "stopping", stop_recorded: true });

        const third = launch();
        await waitForRecord(third);
        expect((await entries()).filter((entry) => entry.type === "previous_host_unclean")).toHaveLength(2);
    } finally {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            await Promise.race([child.exited, Bun.sleep(5_000)]);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await child.exited;
        }
        await Promise.all(errors);
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
