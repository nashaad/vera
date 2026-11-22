import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_CAPABILITY_STORAGE } from "../../src/host/capabilities.ts";
import { connectHost } from "../../src/host/connection.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { startHostServer } from "../../src/host/server.ts";
import type {
    StorageCleanupPreview,
    StorageCleanupResult,
    StorageMeasurement,
} from "../../src/host/storage-protocol.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryHostDirectory(): { directory: string; socketPath: string } {
    const directory = mkdtempSync(join(tmpdir(), "vera-storage-wire-"));
    temporaryDirectories.push(directory);
    return { directory, socketPath: join(directory, "host.sock") };
}

const measurement: StorageMeasurement = {
    categories: [
        { category: "sessions", bytes: 2048, items: 2, summary: "1 session", largest: [{ name: "Plan the launch", bytes: 2048 }] },
    ],
    total_bytes: 2048,
    measured_at: "2026-11-22T12:00:00.000Z",
    partial: false,
    old_scratch: {
        category: "old_scratch",
        bytes: 0,
        items: 0,
        summary: "0 temporary session folders",
        largest: [],
    },
};

const preview: StorageCleanupPreview = {
    area: "scratch",
    max_age_days: 7,
    count: 2,
    bytes: 4096,
    names: ["idle-one", "idle-two"],
    more: 0,
    partial: false,
};

const result: StorageCleanupResult = {
    area: "scratch",
    max_age_days: 7,
    removed: 2,
    removed_bytes: 4096,
};

test("storage requests parse their facts and refuse invalid areas and ages", () => {
    expect(parseHostRequest(JSON.stringify({ type: "storage_measure", refresh: true }))).toEqual({
        type: "storage_measure",
        refresh: true,
    });
    expect(parseHostRequest(JSON.stringify({ type: "storage_measure" }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({
        type: "storage_cleanup_preview",
        area: "old_scratch",
        max_age_days: 30,
    }))).toEqual({
        type: "storage_cleanup_preview",
        area: "old_scratch",
        max_age_days: 30,
    });
    expect(parseHostRequest(JSON.stringify({
        type: "storage_cleanup",
        area: "logs",
        max_age_days: 1,
    }))).toEqual({ type: "storage_cleanup", area: "logs", max_age_days: 1 });
    for (const invalid of [
        { type: "storage_cleanup", area: "sessions", max_age_days: 7 },
        { type: "storage_cleanup", area: "scratch", max_age_days: 0 },
        { type: "storage_cleanup", area: "scratch", max_age_days: 1.5 },
        { type: "storage_cleanup", area: "scratch", max_age_days: 3651 },
        { type: "storage_cleanup", area: "scratch", max_age_days: "7" },
    ]) {
        expect(parseHostRequest(JSON.stringify(invalid))).toBeUndefined();
    }
});

test("the host answers storage requests with the measure and cleanup handlers", async () => {
    const { directory, socketPath } = temporaryHostDirectory();
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_STORAGE],
        storageMeasure: async (refresh) => ({ ...measurement, partial: refresh }),
        storageCleanupPreview: async (area, maxAgeDays) => ({ ...preview, area, max_age_days: maxAgeDays }),
        storageCleanup: async (area, maxAgeDays) => ({ ...result, area, max_age_days: maxAgeDays }),
    });
    try {
        const identity = await connectHost({ socketPath });
        await identity.send({ type: "host_identity" });
        const identityReply = await identity.receive() as { type: string; capabilities?: readonly string[] };
        expect(identityReply.type).toBe("host_identity");
        expect(identityReply.capabilities).toContain(HOST_CAPABILITY_STORAGE);
        identity.close();

        const measure = await connectHost({ socketPath });
        await measure.send({ type: "storage_measure", refresh: true });
        expect(await measure.receive()).toEqual({
            type: "storage_measured",
            measurement: { ...measurement, partial: true },
        });
        measure.close();

        const check = await connectHost({ socketPath });
        await check.send({ type: "storage_cleanup_preview", area: "logs", max_age_days: 30 });
        expect(await check.receive()).toEqual({
            type: "storage_cleanup_previewed",
            preview: { ...preview, area: "logs", max_age_days: 30 },
        });
        check.close();

        const remove = await connectHost({ socketPath });
        await remove.send({ type: "storage_cleanup", area: "old_scratch", max_age_days: 1 });
        expect(await remove.receive()).toEqual({
            type: "storage_cleaned",
            result: { ...result, area: "old_scratch", max_age_days: 1 },
        });
        remove.close();
    } finally {
        await server.close();
    }
});

test("the identity reply leaves storage out when the server was not started with it", async () => {
    const { directory, socketPath } = temporaryHostDirectory();
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
    });
    try {
        const identity = await connectHost({ socketPath });
        await identity.send({ type: "host_identity" });
        const identityReply = await identity.receive() as { type: string; capabilities?: readonly string[] };
        expect(identityReply.type).toBe("host_identity");
        expect(identityReply.capabilities).not.toContain(HOST_CAPABILITY_STORAGE);
        identity.close();
    } finally {
        await server.close();
    }
});

test("an older host build answers a storage request with a protocol error", async () => {
    const { directory, socketPath } = temporaryHostDirectory();
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
    });
    try {
        const connection = await connectHost({ socketPath });
        await connection.send({ type: "storage_measure", refresh: false });
        expect(await connection.receive()).toEqual({
            type: "protocol_error",
            reason: "unsupported_or_invalid_command",
        });
        connection.close();
    } finally {
        await server.close();
    }
});
