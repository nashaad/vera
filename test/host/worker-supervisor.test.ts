import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { superviseWorker } from "../../src/host/worker-supervisor-handle.ts";
import { NO_DEADLINE } from "../../src/host/worker-supervisor.ts";

/**
 * Every process here is real and every signal is real. A fake process would
 * prove nothing: the point of the supervisor is that it works against
 * something that refuses to cooperate, and only the operating system can
 * demonstrate that.
 */

const WEDGED_WORKER = fileURLToPath(
    new URL("./fixtures/wedged-worker.ts", import.meta.url),
);
const CRASHING_HOST = fileURLToPath(
    new URL("./fixtures/crashing-host.ts", import.meta.url),
);

const liveHome = mkdtempSync(join(tmpdir(), "vera-supervisor-live-"));
const previousVeraHome = process.env.VERA_HOME;

beforeAll(() => {
    process.env.VERA_HOME = join(liveHome, ".vera");
});

afterAll(() => {
    if (previousVeraHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousVeraHome;
    rmSync(liveHome, { recursive: true, force: true });
});

interface StartedWorker {
    readonly child: ChildProcess;
    readonly pid: number;
}

/** Resolves once the fixture has printed its pid and entered the block. */
async function startWedgedWorker(): Promise<StartedWorker> {
    const child = spawn("bun", [WEDGED_WORKER], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    const pid = Number((await firstLine(child.stdout!)).split(" ")[0]);
    expect(pid).toBeGreaterThan(0);
    return { child, pid };
}

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolveLine, rejectLine) => {
        let buffer = "";
        stream.setEncoding("utf8");
        const onData = (chunk: string): void => {
            buffer += chunk;
            const index = buffer.indexOf("\n");
            if (index !== -1) {
                stream.off("data", onData);
                resolveLine(buffer.slice(0, index));
            }
        };
        stream.on("data", onData);
        stream.once("error", rejectLine);
    });
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (!isAlive(pid)) {
            return true;
        }
        await Bun.sleep(25);
    }
    return !isAlive(pid);
}

function exitOf(
    child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> {
    return new Promise((resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
}

describe("worker supervisor", () => {
    test("kills a wedged worker at the deadline", async () => {
        const worker = await startWedgedWorker();
        const exit = exitOf(worker.child);

        // The worker ignores this. It is sent only to establish that it does.
        worker.child.kill("SIGTERM");
        await Bun.sleep(300);
        expect(isAlive(worker.pid)).toBe(true);

        const events: Record<string, unknown>[] = [];
        const handle = superviseWorker({
            pid: worker.pid,
            deadlineMs: Date.now() + 700,
            onEvent: (event) => {
                events.push(event);
            },
        });

        expect(await waitUntilGone(worker.pid, 5_000)).toBe(true);
        expect((await exit).signal).toBe("SIGKILL");
        await handle.exited;

        const killed = events.find((event) => event.type === "killed");
        expect(killed).toEqual({
            v: 1,
            type: "killed",
            pid: worker.pid,
            reason: "deadline",
        });
        expect(events.at(-1)).toEqual({ v: 1, type: "exit", reason: "deadline" });
    }, 20_000);

    test("NO_DEADLINE never fires but leaves the host switch armed", async () => {
        const worker = await startWedgedWorker();
        const exit = exitOf(worker.child);

        const handle = superviseWorker({
            pid: worker.pid,
            deadlineMs: NO_DEADLINE,
        });

        await Bun.sleep(1_500);
        expect(isAlive(worker.pid)).toBe(true);

        handle.detach();

        expect(await waitUntilGone(worker.pid, 5_000)).toBe(true);
        expect((await exit).signal).toBe("SIGKILL");
        await handle.exited;
    }, 20_000);

    test("a host-side extension moves the deadline out", async () => {
        const worker = await startWedgedWorker();
        const exit = exitOf(worker.child);
        const handle = superviseWorker({
            pid: worker.pid,
            deadlineMs: Date.now() + 600,
        });

        handle.extendDeadline(Date.now() + 3_000);
        await Bun.sleep(1_500);
        expect(isAlive(worker.pid)).toBe(true);

        expect(await waitUntilGone(worker.pid, 5_000)).toBe(true);
        expect((await exit).signal).toBe("SIGKILL");
        await handle.exited;
    }, 20_000);

    test("a dead host takes the worker with it and leaves no orphan", async () => {
        const worker = await startWedgedWorker();
        const exit = exitOf(worker.child);

        const host = spawn(
            "bun",
            [CRASHING_HOST, String(worker.pid), String(Date.now() + 600_000)],
            { stdio: ["ignore", "pipe", "inherit"] },
        );
        const supervisorPid = Number(
            (await firstLine(host.stdout!)).split(" ")[0],
        );
        expect(supervisorPid).toBeGreaterThan(0);
        await Bun.sleep(300);
        expect(isAlive(worker.pid)).toBe(true);

        host.kill("SIGKILL");

        expect(await waitUntilGone(worker.pid, 5_000)).toBe(true);
        expect((await exit).signal).toBe("SIGKILL");
        expect(await waitUntilGone(supervisorPid, 5_000)).toBe(true);
    }, 20_000);

    test("a dead worker ends the supervisor", async () => {
        const worker = spawn("bun", ["-e", "setTimeout(() => {}, 400)"], {
            stdio: ["ignore", "ignore", "inherit"],
        });
        const events: Record<string, unknown>[] = [];
        const handle = superviseWorker({
            pid: worker.pid as number,
            deadlineMs: Date.now() + 600_000,
            onEvent: (event) => {
                events.push(event);
            },
        });

        await handle.exited;
        expect(events.at(-1)).toEqual({
            v: 1,
            type: "exit",
            reason: "worker_exited",
        });
    }, 20_000);

    test("an explicit kill from the host is immediate", async () => {
        const worker = await startWedgedWorker();
        const exit = exitOf(worker.child);
        const handle = superviseWorker({
            pid: worker.pid,
            deadlineMs: Date.now() + 600_000,
        });

        handle.killNow();
        expect(await waitUntilGone(worker.pid, 5_000)).toBe(true);
        expect((await exit).signal).toBe("SIGKILL");
        await handle.exited;
    }, 20_000);
});
