import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    damagedLockMayHoldHost,
    defaultHostLockPath,
    inspectHostLockFileSync,
} from "../host/lockfile.ts";
import {
    checkRecordIdentity,
    processIsAlive,
} from "../host/process-identity.ts";
import {
    currentReleaseBuildId,
    defaultInstallPrefix,
    rollbackReleaseBuildId,
    veraShareRoot,
} from "./layout.ts";

export type ReleaseReferenceReason =
    | "activated"
    | "host-build-unknown"
    | "host-lock-damaged"
    | "live-host"
    | "rollback"
    | "upgrade";

export interface ReleaseReference {
    readonly buildId: string;
    readonly reason: ReleaseReferenceReason;
}

export function rollbackProtectedBuildIds(
    prefix = defaultInstallPrefix(),
): readonly string[] {
    const buildId = rollbackReleaseBuildId(prefix);
    return buildId === undefined ? [] : [buildId];
}

export function listReleaseReferences(
    prefix = defaultInstallPrefix(),
): readonly ReleaseReference[] {
    const references: ReleaseReference[] = [];
    const seen = new Set<string>();

    function add(buildId: string | undefined, reason: ReleaseReferenceReason): void {
        if (buildId === undefined || buildId.length === 0) return;
        const key = `${reason}:${buildId}`;
        if (seen.has(key)) return;
        seen.add(key);
        references.push({ buildId, reason });
    }

    add(currentReleaseBuildId(prefix), "activated");
    add(liveHostBuildId(), "live-host");
    for (const buildId of rollbackProtectedBuildIds(prefix)) {
        add(buildId, "rollback");
    }
    for (const buildId of upgradeJournalBuildIds(prefix)) {
        add(buildId, "upgrade");
    }
    return references;
}

export function referencedBuildIds(
    prefix = defaultInstallPrefix(),
): ReadonlySet<string> {
    return new Set(listReleaseReferences(prefix).map((item) => item.buildId));
}

export function isReleaseReferenced(
    buildId: string,
    prefix = defaultInstallPrefix(),
): boolean {
    return referenceReasons(buildId, prefix).length > 0;
}

export function referenceReasons(
    buildId: string,
    prefix = defaultInstallPrefix(),
): readonly ReleaseReferenceReason[] {
    const reasons = listReleaseReferences(prefix)
        .filter((item) => item.buildId === buildId)
        .map((item) => item.reason);
    const hold = hostLockHold();
    return hold === undefined ? reasons : [...reasons, hold.reason];
}

export interface HostLockHold {
    readonly reason: "host-build-unknown" | "host-lock-damaged";
    readonly message: string;
}

// Some host lockfiles cannot say which release their host runs. While a host
// may be running, every release is held. Returns why, or undefined.
export function hostLockHold(
    lockPath: string = defaultHostLockPath(),
): HostLockHold | undefined {
    const damaged = damagedHostLockHold(lockPath);
    if (damaged !== undefined) {
        return { reason: "host-lock-damaged", message: damaged };
    }
    const unknown = unknownBuildHostHold(lockPath);
    return unknown === undefined
        ? undefined
        : { reason: "host-build-unknown", message: unknown };
}

// A damaged lockfile cannot say which release its host runs, so every release
// is held unless its PID is dead or clearly not Vera. Returns why, or undefined.
export function damagedHostLockHold(
    lockPath: string = defaultHostLockPath(),
): string | undefined {
    const inspection = inspectHostLockFileSync(lockPath);
    if (inspection.state !== "damaged") return undefined;
    if (!damagedLockMayHoldHost(inspection)) return undefined;
    const keeping = "Keeping every release until it is fixed or deleted.";
    if (inspection.pid === undefined) {
        return `The host lockfile ${lockPath} is damaged and names no PID, so Vera cannot tell which release a running host uses. ${keeping}`;
    }
    return `The host lockfile ${lockPath} is damaged and PID ${inspection.pid} may be a running Vera host, so Vera cannot tell which release it uses. ${keeping}`;
}

// A valid schema 1 or 2 lockfile has no build id. Its host may run from any
// release, so none is safe while that PID is alive and not provably another program.
export function unknownBuildHostHold(
    lockPath: string = defaultHostLockPath(),
): string | undefined {
    const inspection = inspectHostLockFileSync(lockPath);
    if (inspection.state !== "valid") return undefined;
    const record = inspection.record;
    if (record.build_id !== undefined) return undefined;
    if (!processIsAlive(record.pid)) return undefined;
    if (checkRecordIdentity(record) === "mismatch") return undefined;
    return `The host lockfile ${lockPath} names no build, so Vera cannot tell which release PID ${record.pid} uses. Keeping every release until that host exits.`;
}

/** File-only read of host.json. GC must not handshake: a wedged host still uses its release, and a hang would block the one command that should leave that release alone. */
function liveHostBuildId(
    lockPath: string = defaultHostLockPath(),
): string | undefined {
    const record = readHostRecordFile(lockPath);
    if (record === undefined || record.build_id === undefined) {
        return undefined;
    }
    if (!processIsAlive(record.pid)) {
        return undefined;
    }
    return record.build_id;
}

function readHostRecordFile(lockPath: string): {
    readonly pid: number;
    readonly build_id?: string;
} | undefined {
    let text: string;
    try {
        text = readFileSync(lockPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw new Error(
            `Host record at ${lockPath} is unreadable: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) {
        return undefined;
    }
    const buildId = record.build_id;
    return {
        pid: record.pid as number,
        ...(typeof buildId === "string" && buildId.length > 0
            ? { build_id: buildId }
            : {}),
    };
}

function upgradeJournalBuildIds(prefix: string): readonly string[] {
    const path = join(veraShareRoot(prefix), "upgrade.json");
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw new Error(
            `Upgrade journal at ${path} is unreadable: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (error) {
        throw new Error(
            `Upgrade journal at ${path} is not JSON: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Upgrade journal at ${path} must be an object`);
    }
    const record = parsed as Record<string, unknown>;
    const ids: string[] = [];
    if (typeof record.from_build_id === "string" && record.from_build_id.length > 0) {
        ids.push(record.from_build_id);
    }
    if (typeof record.to_build_id === "string" && record.to_build_id.length > 0) {
        ids.push(record.to_build_id);
    }
    return ids;
}
