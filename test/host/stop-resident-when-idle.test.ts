import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stopResidentHostWhenIdle } from "../../src/host/force-stop.ts";
import { startHostServer } from "../../src/host/server.ts";
import { StopWhenIdle, type StopWaitTarget } from "../../src/host/stop-when-idle.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "stopResidentHostWhenIdle waits for a verified host to finish its turns",
    async () => {
        const directory = mkdtempSync(join("/private/tmp", "vera-stop-when-idle-"));
        directories.push(directory);
        let waiting: StopWaitTarget[] = [{ session_id: "s1", name: "build", status: "working" }];
        let alive = true;
        const control = new StopWhenIdle({
            waitingOn: () => waiting,
            onStopped: () => {
                alive = false;
                void server.close();
            },
            pollIntervalMs: 5,
        });
        const server = await startHostServer({
            socketPath: join(directory, "host.sock"),
            lockPath: join(directory, "host.json"),
            pid: 104,
            startedAt: "2026-07-17T12:00:00.123Z",
            stopWhenIdle: control,
        });
        const seen: StopWaitTarget[][] = [];
        setTimeout(() => {
            waiting = [];
        }, 60);
        const outcome = await stopResidentHostWhenIdle({
            lockPath: join(directory, "host.json"),
            isProcessAlive: () => alive,
            matchesRecord: () => true,
            pollIntervalMs: 5,
            onWaiting: (targets) => {
                seen.push([...targets]);
            },
        });
        expect(outcome).toEqual({ pid: 104, endedBy: "stopped" });
        expect(seen[0]).toEqual([{ session_id: "s1", name: "build", status: "working" }]);
    },
);

test("stopResidentHostWhenIdle reports a host that does not accept stops, and never signals a verified host", async () => {
    const directory = mkdtempSync(join("/private/tmp", "vera-stop-when-idle-"));
    directories.push(directory);
    const server = await startHostServer({
        socketPath: join(directory, "host.sock"),
        lockPath: join(directory, "host.json"),
        pid: 105,
        startedAt: "2026-07-17T12:00:00.123Z",
    });
    try {
        const kill = (): void => {
            throw new Error("a verified host must not be signalled by a plain stop");
        };
        expect(await stopResidentHostWhenIdle({
            lockPath: join(directory, "host.json"),
            isProcessAlive: () => true,
            matchesRecord: () => true,
            kill,
        })).toMatchObject({ pid: 105, endedBy: "refused", refusal: "unavailable" });
        expect(await stopResidentHostWhenIdle({
            lockPath: join(directory, "host.json"),
            isProcessAlive: () => true,
            matchesRecord: () => true,
            kill,
            requestStop: async () => ({ type: "no_answer" }),
        })).toEqual({ pid: 105, endedBy: "no_answer" });
    } finally {
        await server.close();
    }
});

test("an update never signals a host it cannot confirm, and reports the refusal", async () => {
    const directory = mkdtempSync(join("/private/tmp", "vera-stop-update-"));
    directories.push(directory);
    const kill = (): void => {
        throw new Error("an update must not signal a host");
    };
    const lockPath = join(directory, "host.json");
    writeFileSync(lockPath, "{not json");
    expect(await stopResidentHostWhenIdle({
        lockPath,
        targetBuildId: "vera-new",
        isProcessAlive: () => true,
        kill,
    })).toMatchObject({ endedBy: "refused", refusal: "identity_mismatch" });
    expect(await stopResidentHostWhenIdle({
        lockPath: join(directory, "absent.json"),
        targetBuildId: "vera-new",
        kill,
    })).toBeUndefined();
});

test("an update reports stopped at once and forwards the target to the host", async () => {
    const directory = mkdtempSync(join("/private/tmp", "vera-stop-target-"));
    directories.push(directory);
    const server = await startHostServer({
        socketPath: join(directory, "host.sock"),
        lockPath: join(directory, "host.json"),
        pid: 106,
        startedAt: "2026-07-17T12:00:00.123Z",
    });
    const seen: unknown[] = [];
    try {
        expect(await stopResidentHostWhenIdle({
            lockPath: join(directory, "host.json"),
            isProcessAlive: () => true,
            matchesRecord: () => true,
            targetBuildId: "vera-new",
            detach: true,
            kill: () => {
                throw new Error("an update must not signal a host");
            },
            requestStop: async (_socket, _identity, _onWaiting, options) => {
                seen.push(options);
                return { type: "accepted" };
            },
        })).toEqual({ pid: 106, endedBy: "accepted" });
        expect(seen).toEqual([{ targetBuildId: "vera-new", detach: true }]);
    } finally {
        await server.close();
    }
});
