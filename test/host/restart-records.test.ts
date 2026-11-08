import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    dismissRestartRecordThroughHost,
    listRestartRecordsThroughHost,
} from "../../src/host/restart-records-client.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { startHostServer, type RestartRecordsPort } from "../../src/host/server.ts";
import {
    appendRestartRecord,
    clearRestartRecordsForSession,
    listRestartRecords,
} from "../../src/store/restart-records.ts";

const socketTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

const at = "2026-11-07T10:00:00.000Z";

test("parses both restart record requests and rejects bad session ids", () => {
    expect(parseHostRequest(JSON.stringify({ type: "restart_records" })))
        .toEqual({ type: "restart_records" });
    expect(parseHostRequest(JSON.stringify({
        type: "restart_record_dismiss",
        session_id: "crow-1",
    }))).toEqual({ type: "restart_record_dismiss", session_id: "crow-1" });
    expect(parseHostRequest(JSON.stringify({ type: "restart_record_dismiss" })))
        .toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "restart_record_dismiss",
        session_id: "",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "restart_record_dismiss",
        session_id: "a\u0000b",
    }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "restart_record_dismiss",
        session_id: "x".repeat(257),
    }))).toBeUndefined();
});

function filePort(path: string): RestartRecordsPort {
    return {
        list: () => listRestartRecords(path),
        dismiss: (sessionId) => clearRestartRecordsForSession(sessionId, path),
    };
}

socketTest("restart record requests round trip through a real host", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-restart-wire-"));
    const socketPath = join(root, "host.sock");
    const recordPath = join(root, "restarts.jsonl");
    appendRestartRecord({ session_id: "crow-1", cause: "crash", at }, recordPath);
    appendRestartRecord(
        { session_id: "crow-2", cause: "update", target_build_id: "b2", at },
        recordPath,
    );
    appendRestartRecord({ session_id: "crow-1", cause: "stop", at }, recordPath);
    const host = await startHostServer({
        socketPath,
        lockPath: join(root, "host.json"),
        restartRecords: filePort(recordPath),
    });

    try {
        expect(await listRestartRecordsThroughHost(socketPath)).toEqual([
            { session_id: "crow-1", cause: "crash", at },
            { session_id: "crow-2", cause: "update", target_build_id: "b2", at },
            { session_id: "crow-1", cause: "stop", at },
        ]);
        expect(await dismissRestartRecordThroughHost(socketPath, "crow-1"))
            .toEqual({ status: "dismissed", removed: 2 });
        expect(await listRestartRecordsThroughHost(socketPath)).toEqual([
            { session_id: "crow-2", cause: "update", target_build_id: "b2", at },
        ]);
        expect(await dismissRestartRecordThroughHost(socketPath, "ghost"))
            .toEqual({ status: "dismissed", removed: 0 });
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

socketTest("a failed dismiss reports failure and keeps the list", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-restart-fail-"));
    const socketPath = join(root, "host.sock");
    const host = await startHostServer({
        socketPath,
        lockPath: join(root, "host.json"),
        restartRecords: {
            list: () => [{ session_id: "crow-1", cause: "crash", at }],
            dismiss: () => {
                throw new Error("disk full");
            },
        },
    });

    try {
        expect(await dismissRestartRecordThroughHost(socketPath, "crow-1"))
            .toEqual({ status: "failed" });
        expect(await listRestartRecordsThroughHost(socketPath)).toEqual([
            { session_id: "crow-1", cause: "crash", at },
        ]);
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

socketTest("a host without a records port lists nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-restart-none-"));
    const socketPath = join(root, "host.sock");
    const host = await startHostServer({
        socketPath,
        lockPath: join(root, "host.json"),
    });

    try {
        expect(await listRestartRecordsThroughHost(socketPath)).toEqual([]);
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});
