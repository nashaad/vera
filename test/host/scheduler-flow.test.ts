import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a persisted schedule produces ordinary acknowledged inbox entries",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-scheduler-flow-"));
        const socketPath = join(root, "host.sock");
        const lockPath = join(root, "host.json");
        const inboxPath = join(root, "inbox.db");
        const schedulePath = join(root, "schedules.db");
        let host: ResidentHost | undefined;
        const start = () => startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
                experimental: { inbox: true },
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath,
            sessionDirectory: join(root, "sessions"),
            inboxPath,
            schedulePath,
        });
        try {
            host = await start();
            expect(await runScheduleOperationThroughHost(socketPath, {
                action: "add",
                id: "daily-review",
                cron: "0 9 * * *",
                timezone: "UTC",
                address: "claude:scheduled",
                payload: { text: "Review open work" },
            })).toMatchObject({
                schedule_id: "daily-review",
                enabled: true,
                misfire_policy: "coalesce",
            });
            await runScheduleOperationThroughHost(socketPath, {
                action: "run",
                id: "daily-review",
            });
            const inbox = Inbox.open(inboxPath);
            const first = inbox.entry(1);
            expect(first).toMatchObject({
                seq: 1,
                source: "vera.scheduler",
                kind: "schedule.triggered",
                actor: "scheduler:daily-review",
                address: "claude:scheduled",
            });
            expect(JSON.parse(first!.payload)).toMatchObject({
                version: 1,
                schedule_id: "daily-review",
                payload: { text: "Review open work" },
            });
            inbox.close();
            expect(await runScheduleOperationThroughHost(socketPath, {
                action: "show",
                id: "daily-review",
            })).toMatchObject({
                runs: [{ status: "emitted", inbox_message_id: 1 }],
            });

            await host.close();
            host = await start();
            expect(await runScheduleOperationThroughHost(socketPath, {
                action: "list",
            })).toMatchObject({
                schedules: [{ schedule_id: "daily-review", enabled: true }],
            });
            await runScheduleOperationThroughHost(socketPath, {
                action: "run",
                id: "daily-review",
            });
            const reopened = Inbox.open(inboxPath);
            expect(reopened.entry(2)).toMatchObject({
                seq: 2,
                source: "vera.scheduler",
            });
            reopened.close();
        } finally {
            await host?.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    20_000,
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the inbox kill switch also disables scheduling",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-scheduler-off-"));
        const socketPath = join(root, "host.sock");
        const schedulePath = join(root, "schedules.db");
        let host: ResidentHost | undefined;
        try {
            host = await startResidentHost({
                config: {
                    schema_version: 1,
                    provider: "openrouter",
                    model: "faux/test",
                    approval_mode: "auto",
                    experimental: { inbox: false },
                },
                createAdapter: () => new FauxAdapter([]),
                socketPath,
                lockPath: join(root, "host.json"),
                sessionDirectory: join(root, "sessions"),
                inboxPath: join(root, "inbox.db"),
                schedulePath,
            });
            await expect(runScheduleOperationThroughHost(socketPath, {
                action: "list",
            })).rejects.toThrow("Scheduling is unavailable");
            expect(existsSync(schedulePath)).toBe(false);
        } finally {
            await host?.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    20_000,
);
