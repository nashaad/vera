import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
        })).toEqual({ pid: 105, endedBy: "refused", refusal: "unavailable" });
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
