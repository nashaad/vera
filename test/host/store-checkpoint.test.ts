import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkpointStoresThroughHost } from "../../src/host/store-checkpoint-client.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ScheduleStore } from "../../src/scheduler/store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the daily host checkpoints sqlite stores through backup, not a main-file copy",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-store-checkpoint-"));
        const socketPath = join(root, "host.sock");
        const destination = join(root, "snapshot");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
                experimental: { inbox: true },
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            inboxPath: join(root, "inbox.db"),
            schedulePath: join(root, "schedules.db"),
        });
        try {
            await runScheduleOperationThroughHost(socketPath, {
                action: "add",
                id: "daily-review",
                cron: "0 9 * * *",
                timezone: "UTC",
                address: "peer",
                payload: { text: "Review" },
            });
            const result = await checkpointStoresThroughHost(
                socketPath,
                destination,
            );
            expect(result.databases).toEqual(["inbox.db", "schedules.db"]);
            const schedules = ScheduleStore.open(
                join(destination, "schedules.db"),
            );
            try {
                expect(schedules.get("daily-review")?.id).toBe("daily-review");
            } finally {
                schedules.close();
            }
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a failed checkpoint refuses rather than leaving a clone database",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-store-checkpoint-fail-"));
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
                experimental: { inbox: true },
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            inboxPath: join(root, "inbox.db"),
            schedulePath: join(root, "schedules.db"),
        });
        try {
            await expect(checkpointStoresThroughHost(
                socketPath,
                "relative-dest",
            )).rejects.toThrow();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
