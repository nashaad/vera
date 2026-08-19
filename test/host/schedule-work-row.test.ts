import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachAgent } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_WORK_INDEX } from "../../src/host/capabilities.ts";
import { runScheduleOperationThroughHost } from "../../src/host/schedule-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

/**
 * A schedule run reaching the work inbox, through the real scheduler, the real
 * schedule database and a real attachment.
 *
 * A schedule addresses a consumer label and a session's label is its agent id,
 * so this is also what proves the row can be opened: the row names a session
 * the host is actually holding.
 */

const socketTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

socketTest("a completed run becomes a done row naming its session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-schedule-work-"));
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
    await host.registry.create({ id: "agent-1", workspace: root });
    const client = await attachAgent({
        socketPath,
        agentId: "agent-1",
        requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX],
    });
    try {
        // About this session only: the inbox is machine-wide, so what else is
        // on it is not this test's business.
        await Bun.sleep(100);
        expect((client.workIndex?.rows ?? [])
            .filter((row) => row.session_id === "agent-1")).toEqual([]);

        await runScheduleOperationThroughHost(socketPath, {
            action: "add",
            id: "nightly-digest",
            cron: "0 9 * * *",
            timezone: "UTC",
            // The session's own agent id, which is what its inbox consumer
            // label is, so the run resolves to a session the host holds.
            address: "agent-1",
            payload: { text: "Review open work" },
        });
        await runScheduleOperationThroughHost(socketPath, {
            action: "run",
            id: "nightly-digest",
        });

        const index = await untilIndex(
            client,
            (candidate) =>
                candidate.rows.some((row) => row.reason === "schedule"),
        );
        const row = index.rows.find((candidate) =>
            candidate.reason === "schedule");
        expect(row?.section).toBe("done_recently");
        expect(row?.summary).toBe("Scheduled run completed");
        expect(row?.session_id).toBe("agent-1");
        expect(row?.session_path).toContain("agent-1");
        expect(row?.id.startsWith("schedule:nightly-digest:")).toBe(true);
    } finally {
        client.close();
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

socketTest("a run addressed to nothing this host holds shows no row", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-schedule-orphan-"));
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
    await host.registry.create({ id: "agent-1", workspace: root });
    const client = await attachAgent({
        socketPath,
        agentId: "agent-1",
        requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX],
    });
    try {
        await runScheduleOperationThroughHost(socketPath, {
            action: "add",
            id: "elsewhere",
            cron: "0 9 * * *",
            timezone: "UTC",
            address: "claude:somewhere-else",
            payload: { text: "Review open work" },
        });
        await runScheduleOperationThroughHost(socketPath, {
            action: "run",
            id: "elsewhere",
        });
        await Bun.sleep(300);

        // A row whose enter key opens nothing is worse than no row.
        expect(client.workIndex?.rows.some((row) => row.reason === "schedule"))
            .not.toBe(true);
    } finally {
        client.close();
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

async function untilIndex(
    client: {
        readonly workIndex: WorkIndexSnapshot | undefined;
        onWorkIndex(listener: (index: WorkIndexSnapshot) => void): () => void;
    },
    matches: (index: WorkIndexSnapshot) => boolean,
): Promise<WorkIndexSnapshot> {
    if (client.workIndex !== undefined && matches(client.workIndex)) {
        return client.workIndex;
    }
    return new Promise((resolve) => {
        const stop = client.onWorkIndex((index) => {
            if (!matches(index)) return;
            stop();
            resolve(index);
        });
    });
}
