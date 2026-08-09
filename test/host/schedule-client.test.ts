import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { startHostServer } from "../../src/host/server.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "schedule operations cross the resident host protocol",
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "vera-schedule-client-"));
        const calls: unknown[] = [];
        const server = await startHostServer({
            socketPath: join(directory, "host.sock"),
            lockPath: join(directory, "host.json"),
            runScheduleOperation: async (operation) => {
                calls.push(operation);
                return { schedule_id: "daily", enabled: true };
            },
        });
        try {
            expect(await runScheduleOperationThroughHost(server.socketPath, {
                action: "pause",
                id: "daily",
            })).toEqual({ schedule_id: "daily", enabled: true });
            expect(calls).toEqual([{ action: "pause", id: "daily" }]);
        } finally {
            await server.close();
            rmSync(directory, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "schedule host failures preserve user-facing validation",
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "vera-schedule-client-"));
        const server = await startHostServer({
            socketPath: join(directory, "host.sock"),
            lockPath: join(directory, "host.json"),
            runScheduleOperation: async () => {
                const { UserFacingError } = await import(
                    "../../src/user-facing-error.ts"
                );
                throw new UserFacingError("unknown schedule daily");
            },
        });
        try {
            await expect(runScheduleOperationThroughHost(server.socketPath, {
                action: "show",
                id: "daily",
            })).rejects.toThrow("unknown schedule daily");
        } finally {
            await server.close();
            rmSync(directory, { recursive: true, force: true });
        }
    },
);
