import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultHostLockPath } from "../host/lockfile.ts";
import { processIsAlive } from "../host/process-identity.ts";
import {
    currentReleaseBuildId,
    defaultInstallPrefix,
    rollbackReleaseBuildId,
    veraShareRoot,
} from "./layout.ts";

export type ReleaseReferenceReason =
    | "activated"
    | "live-host"
    | "rollback"
    | "upgrade";

export interface ReleaseReference {
    readonly buildId: string;
    readonly reason: ReleaseReferenceReason;
}

/**
 * Builds rollback must be able to restore. The pin is the `rollback`
 * symlink next to `current`. Not a locator and not a search.
 */
export function rollbackProtectedBuildIds(
    prefix = defaultInstallPrefix(),
): readonly string[] {
    const buildId = rollbackReleaseBuildId(prefix);
    return buildId === undefined ? [] : [buildId];
}

/**
 * Every build that must stay on disk. The set is the policy: activated
 * current, a live host, an in-flight upgrade journal if one is present,
 * and the rollback pin. There is no keep-N count. A number would hide a
 * missing reference.
 */
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
    return referencedBuildIds(prefix).has(buildId);
}

export function referenceReasons(
    buildId: string,
    prefix = defaultInstallPrefix(),
): readonly ReleaseReferenceReason[] {
    return listReleaseReferences(prefix)
        .filter((item) => item.buildId === buildId)
        .map((item) => item.reason);
}

/**
 * File-only read of host.json. GC must not handshake: a wedged host still
 * uses its release, and a hang would block the one command that should
 * leave that release alone. A pid that cannot be inspected is treated as
 * live, because unknown is not evidence the host is gone.
 */
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
