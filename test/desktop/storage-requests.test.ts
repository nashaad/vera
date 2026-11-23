import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    measureStorage,
    parseStorageCleanupResult,
    parseStorageMeasurement,
    parseStoragePreview,
    previewStorageCleanup,
    runStorageCleanup,
} from "../../clients/desktop/src/storage-requests.ts";
import type {
    StorageCleanupPreview,
    StorageCleanupResult,
    StorageMeasurement,
} from "../../clients/ui/src/protocol/storage.ts";
import { socketTest } from "../support/socket-probe.ts";

const MEASUREMENT: StorageMeasurement = {
    categories: [
        {
            category: "sessions",
            bytes: 2048,
            items: 2,
            summary: "1 session",
            largest: [{ name: "Plan the launch", bytes: 2048 }],
        },
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

const PREVIEW: StorageCleanupPreview = {
    area: "scratch",
    max_age_days: 7,
    count: 2,
    bytes: 4096,
    names: ["idle-one", "idle-two"],
    more: 0,
    partial: false,
};

const RESULT: StorageCleanupResult = { area: "scratch", max_age_days: 7, removed: 2, removed_bytes: 4096 };

async function serve(
    socketPath: string,
    answer: (request: Record<string, unknown>) => unknown | undefined,
    requests: Record<string, unknown>[],
): Promise<{ close: () => Promise<void> }> {
    const server = createServer((socket: Socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const newline = buffer.indexOf("\n");
            if (newline === -1) return;
            const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
            buffer = buffer.slice(newline + 1);
            requests.push(request);
            const reply = answer(request);
            if (reply === undefined) {
                socket.destroy();
                return;
            }
            socket.end(`${JSON.stringify(reply)}\n`);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
    });
    return {
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

describe("the host's storage answers", () => {
    test("@core a measurement is read as plain facts", () => {
        expect(parseStorageMeasurement(MEASUREMENT)).toEqual(MEASUREMENT);
        for (const reply of [
            undefined,
            null,
            {},
            { ...MEASUREMENT, total_bytes: -1 },
            { ...MEASUREMENT, measured_at: 3 },
            { ...MEASUREMENT, partial: "no" },
            { ...MEASUREMENT, categories: "sessions" },
            { ...MEASUREMENT, categories: [{ ...MEASUREMENT.categories[0], category: "photos" }] },
            { ...MEASUREMENT, categories: [{ ...MEASUREMENT.categories[0], largest: [{ name: 7, bytes: 2 }] }] },
            { ...MEASUREMENT, old_scratch: undefined },
            { ...MEASUREMENT, old_scratch: { ...MEASUREMENT.old_scratch, category: "other" } },
        ]) {
            expect(parseStorageMeasurement(reply)).toBeUndefined();
        }
    });

    test("@core a cleanup preview is read, and a result carries the bytes it freed", () => {
        expect(parseStoragePreview(PREVIEW)).toEqual(PREVIEW);
        expect(parseStorageCleanupResult(RESULT)).toEqual(RESULT);
        for (const reply of [
            { ...PREVIEW, area: "sessions" },
            { ...PREVIEW, max_age_days: 0 },
            { ...PREVIEW, count: -1 },
            { ...PREVIEW, names: [7] },
            { ...PREVIEW, more: -1 },
        ]) {
            expect(parseStoragePreview(reply)).toBeUndefined();
        }
        expect(parseStorageCleanupResult({ ...RESULT, removed_bytes: undefined })).toBeUndefined();
        expect(parseStorageCleanupResult({ ...RESULT, area: "other" })).toBeUndefined();
    });
});

describe("asking the host for storage", () => {
    test("no host socket means the host is not running", async () => {
        expect(await measureStorage(undefined, false)).toEqual({ ok: false, reason: "The host is not running." });
        expect(await previewStorageCleanup(undefined, "scratch", 7))
            .toEqual({ ok: false, reason: "The host is not running." });
        expect(await runStorageCleanup(undefined, "scratch", 7))
            .toEqual({ ok: false, reason: "The host is not running." });
    });

    socketTest("@core a measure asks for a fresh scan when asked to refresh and reads the answer", async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-storage-desktop-"));
        const socketPath = join(root, "host.sock");
        const requests: Record<string, unknown>[] = [];
        const host = await serve(socketPath, () => ({ type: "storage_measured", measurement: MEASUREMENT }), requests);
        try {
            expect(await measureStorage(socketPath, true)).toEqual({ ok: true, measurement: MEASUREMENT });
            expect(requests).toEqual([{ type: "storage_measure", refresh: true }]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    });

    socketTest("@core preview and cleanup send the area and age and read their answers", async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-storage-desktop-"));
        const socketPath = join(root, "host.sock");
        const requests: Record<string, unknown>[] = [];
        const host = await serve(socketPath, (request) => request.type === "storage_cleanup_preview"
            ? { type: "storage_cleanup_previewed", preview: PREVIEW }
            : { type: "storage_cleaned", result: RESULT }, requests);
        try {
            expect(await previewStorageCleanup(socketPath, "scratch", 7)).toEqual({ ok: true, preview: PREVIEW });
            expect(await runStorageCleanup(socketPath, "scratch", 7)).toEqual({ ok: true, result: RESULT });
            expect(requests).toEqual([
                { type: "storage_cleanup_preview", area: "scratch", max_age_days: 7 },
                { type: "storage_cleanup", area: "scratch", max_age_days: 7 },
            ]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    });

    socketTest("@core a host that closes on the request, as an older one does, reads as needing a newer host", async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-storage-old-host-"));
        const socketPath = join(root, "old.sock");
        const host = await serve(socketPath, () => undefined, []);
        try {
            expect(await measureStorage(socketPath, false)).toEqual({
                ok: false,
                reason: "This needs a newer Vera host.",
                needsNewerHost: true,
            });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    });
});
