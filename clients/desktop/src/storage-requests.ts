import {
    connectHost,
    HostConnectionClosedError,
    type HostConnection,
} from "../../../src/host/connection.ts";
import type {
    StorageCleanupArea,
    StorageCleanupPreview,
    StorageCleanupResult,
    StorageLargestItem,
    StorageMeasurement,
} from "../../../src/host/storage-protocol.ts";
import {
    STORAGE_AREAS,
    type StorageArea,
    type StorageCleaned,
    type StorageMeasured,
    type StoragePreviewed,
} from "../../ui/src/protocol/storage.ts";

type Fields = Record<string, unknown>;

// A first measure walks the whole home; a warm one answers from memory.
const MEASURE_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 60_000;

const NOT_RUNNING: StorageMeasured = { ok: false, reason: "The host is not running." };
const NEWER_HOST = "This needs a newer Vera host.";

export async function measureStorage(
    socketPath: string | undefined,
    refresh: boolean,
): Promise<StorageMeasured> {
    if (socketPath === undefined) return NOT_RUNNING;
    return withHost(socketPath, "The host did not answer in time.", async (connection) => {
        await connection.send({ type: "storage_measure", refresh });
        const reply = record(await connection.receiveWithin(MEASURE_TIMEOUT_MS, "The host did not answer in time."));
        if (reply?.type === "storage_failed") {
            return { ok: false, reason: "The home could not be measured." };
        }
        const measurement = reply?.type === "storage_measured" ? parseStorageMeasurement(reply.measurement) : undefined;
        return measurement === undefined
            ? { ok: false, reason: "The host did not report storage." }
            : { ok: true, measurement };
    });
}

export async function previewStorageCleanup(
    socketPath: string | undefined,
    area: StorageCleanupArea,
    maxAgeDays: number,
): Promise<StoragePreviewed> {
    if (socketPath === undefined) return { ok: false, reason: "The host is not running." };
    return withHost(socketPath, "The host did not answer in time.", async (connection) => {
        await connection.send({ type: "storage_cleanup_preview", area, max_age_days: maxAgeDays });
        const reply = record(await connection.receiveWithin(CLEANUP_TIMEOUT_MS, "The host did not answer in time."));
        if (reply?.type === "storage_failed") {
            return { ok: false, reason: "The cleanup could not be checked." };
        }
        const preview = reply?.type === "storage_cleanup_previewed" ? parseStoragePreview(reply.preview) : undefined;
        return preview === undefined
            ? { ok: false, reason: "The host did not report a cleanup preview." }
            : { ok: true, preview };
    });
}

export async function runStorageCleanup(
    socketPath: string | undefined,
    area: StorageCleanupArea,
    maxAgeDays: number,
): Promise<StorageCleaned> {
    if (socketPath === undefined) return { ok: false, reason: "The host is not running." };
    return withHost(socketPath, "The host did not answer in time.", async (connection) => {
        await connection.send({ type: "storage_cleanup", area, max_age_days: maxAgeDays });
        const reply = record(await connection.receiveWithin(CLEANUP_TIMEOUT_MS, "The host did not answer in time."));
        if (reply?.type === "storage_failed") {
            return { ok: false, reason: "The cleanup did not finish." };
        }
        const result = reply?.type === "storage_cleaned" ? parseStorageCleanupResult(reply.result) : undefined;
        return result === undefined
            ? { ok: false, reason: "The host did not report what it removed." }
            : { ok: true, result };
    });
}

async function withHost<T extends { ok: boolean }>(
    socketPath: string,
    deadline: string,
    run: (connection: HostConnection) => Promise<T | { ok: false; reason: string; needsNewerHost?: true }>,
): Promise<T | { ok: false; reason: string; needsNewerHost?: true }> {
    let connection: HostConnection | undefined;
    try {
        connection = await connectHost({ socketPath });
    } catch {
        return { ok: false, reason: "The host is not running." };
    }
    try {
        return await run(connection);
    } catch (error) {
        // An unknown request makes an older host drop the socket without an answer.
        if (error instanceof HostConnectionClosedError && !error.expected) {
            return { ok: false, reason: NEWER_HOST, needsNewerHost: true };
        }
        return {
            ok: false,
            reason: error instanceof Error && error.message === deadline ? deadline : "The host did not answer.",
        };
    } finally {
        connection.close();
    }
}

export function parseStorageMeasurement(value: unknown): StorageMeasurement | undefined {
    const fields = record(value);
    if (fields === undefined) return undefined;
    if (typeof fields.measured_at !== "string" || typeof fields.partial !== "boolean") return undefined;
    if (!isCount(fields.total_bytes) || !Array.isArray(fields.categories)) return undefined;
    const categories = fields.categories.flatMap((entry) => parseCategory(entry) ?? []);
    if (categories.length !== fields.categories.length) return undefined;
    const oldScratch = parseCategory(fields.old_scratch);
    if (oldScratch === undefined || oldScratch.category !== "old_scratch") return undefined;
    return {
        categories,
        total_bytes: fields.total_bytes,
        measured_at: fields.measured_at,
        partial: fields.partial,
        old_scratch: oldScratch,
    };
}

function parseCategory(value: unknown): StorageMeasurement["categories"][number] | undefined {
    const fields = record(value);
    if (fields === undefined) return undefined;
    if (!isCategory(fields.category)) return undefined;
    if (!isCount(fields.bytes) || !isCount(fields.items)) return undefined;
    if (typeof fields.summary !== "string" || !Array.isArray(fields.largest)) return undefined;
    const largest = fields.largest.flatMap((entry) => parseLargest(entry) ?? []);
    if (largest.length !== fields.largest.length) return undefined;
    return {
        category: fields.category,
        bytes: fields.bytes,
        items: fields.items,
        summary: fields.summary,
        largest: largest.slice(0, 10),
    };
}

function parseLargest(value: unknown): StorageLargestItem | undefined {
    const fields = record(value);
    return fields !== undefined && typeof fields.name === "string" && isCount(fields.bytes)
        ? { name: fields.name, bytes: fields.bytes }
        : undefined;
}

export function parseStoragePreview(value: unknown): StorageCleanupPreview | undefined {
    const fields = record(value);
    if (fields === undefined || !isCleanupArea(fields.area)) return undefined;
    if (!isAgeDays(fields.max_age_days) || !isCount(fields.count) || !isCount(fields.bytes)) return undefined;
    if (!isCount(fields.more) || typeof fields.partial !== "boolean" || !Array.isArray(fields.names)) return undefined;
    if (!fields.names.every((name) => typeof name === "string")) return undefined;
    return {
        area: fields.area,
        max_age_days: fields.max_age_days,
        count: fields.count,
        bytes: fields.bytes,
        names: fields.names as string[],
        more: fields.more,
        partial: fields.partial,
    };
}

export function parseStorageCleanupResult(value: unknown): StorageCleanupResult | undefined {
    const fields = record(value);
    if (fields === undefined || !isCleanupArea(fields.area)) return undefined;
    return isAgeDays(fields.max_age_days) && isCount(fields.removed) && isCount(fields.removed_bytes)
        ? {
            area: fields.area,
            max_age_days: fields.max_age_days,
            removed: fields.removed,
            removed_bytes: fields.removed_bytes,
        }
        : undefined;
}

function isCategory(value: unknown): value is StorageArea | "old_scratch" {
    return value === "old_scratch"
        || (typeof value === "string" && (STORAGE_AREAS as readonly string[]).includes(value));
}

function isCleanupArea(value: unknown): value is StorageCleanupArea {
    return value === "scratch" || value === "logs" || value === "old_scratch";
}

function isAgeDays(value: unknown): value is number {
    return isCount(value) && value >= 1 && value <= 3650 && Number.isInteger(value);
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): Fields | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Fields
        : undefined;
}
