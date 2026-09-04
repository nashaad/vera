import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import {
    packedReleaseRoot,
    releasesDirectory,
    thisProcessReleaseRoot,
} from "./release/layout.ts";
import { thisProcessBuildId } from "./release/stamp.ts";
import { veraHomeDirectory } from "./profile-paths.ts";

export const DEV_INSTANCE_SCHEMA_VERSION = 1 as const;

/**
 * A pointer to a Vera home, kept outside every home so one pass can find them
 * all. Nothing here is read as configuration and nothing flows back inward.
 */
export interface DevInstanceRecord {
    readonly schema_version: 1;
    readonly home: string;
    readonly source: string;
    readonly build_id: string | undefined;
    readonly registered_at: string;
}

export function devInstanceDirectory(root = homedir()): string {
    return join(root, ".vera-dev", "instances");
}

export function devInstancePath(home: string, root = homedir()): string {
    const key = createHash("sha256").update(home).digest("hex").slice(0, 16);
    return join(devInstanceDirectory(root), `${key}.json`);
}

/**
 * Code running from a packed release under the install prefix is the one Vera a
 * person runs on purpose. Anything else is a candidate build from a checkout.
 * The running file locates itself; a release stamp does not, because a checkout
 * with no pack of its own reports the daily install's stamp.
 */
export function processIsDevelopmentInstance(
    modulePath: string,
    installedRoot = releasesDirectory(),
): boolean {
    const installed = safeRealpath(installedRoot);
    const resolved = safeRealpath(modulePath);
    if (installed === undefined || resolved === undefined) return true;
    return !resolved.startsWith(`${installed}${sep}`);
}

export function registerDevInstance(options: {
    readonly source: string;
    readonly home?: string;
    readonly buildId?: string | undefined;
    readonly root?: string;
}): DevInstanceRecord {
    const record: DevInstanceRecord = {
        schema_version: DEV_INSTANCE_SCHEMA_VERSION,
        home: options.home ?? veraHomeDirectory(),
        source: options.source,
        build_id: options.buildId ?? buildIdOfRunningTree(),
        registered_at: new Date().toISOString(),
    };
    const directory = devInstanceDirectory(options.root);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
        devInstancePath(record.home, options.root),
        `${JSON.stringify(record)}\n`,
        { encoding: "utf8", mode: 0o600 },
    );
    return record;
}

export function dropDevInstance(home: string, root?: string): void {
    try {
        unlinkSync(devInstancePath(home, root));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

/** Entries whose home is gone are dropped as they are read. */
export function listDevInstances(root?: string): DevInstanceRecord[] {
    let names: string[];
    try {
        names = readdirSync(devInstanceDirectory(root));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const records: DevInstanceRecord[] = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const path = join(devInstanceDirectory(root), name);
        const record = readDevInstanceFile(path);
        if (record === undefined) {
            try {
                unlinkSync(path);
            } catch {
                // An unreadable entry must not block the rest of the sweep.
            }
            continue;
        }
        if (!existsSync(record.home)) {
            dropDevInstance(record.home, root);
            continue;
        }
        records.push(record);
    }
    return records.sort((left, right) => left.home.localeCompare(right.home));
}

function readDevInstanceFile(path: string): DevInstanceRecord | undefined {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Partial<DevInstanceRecord>;
    if (record.schema_version !== DEV_INSTANCE_SCHEMA_VERSION) return undefined;
    if (typeof record.home !== "string" || record.home.length === 0) {
        return undefined;
    }
    if (typeof record.source !== "string" || record.source.length === 0) {
        return undefined;
    }
    if (
        typeof record.registered_at !== "string"
        || record.registered_at.length === 0
    ) {
        return undefined;
    }
    return {
        schema_version: DEV_INSTANCE_SCHEMA_VERSION,
        home: record.home,
        source: record.source,
        build_id: typeof record.build_id === "string"
            ? record.build_id
            : undefined,
        registered_at: record.registered_at,
    };
}

/**
 * The stamp names the running tree only when that tree carries a pack of its
 * own. A checkout with no pack reads the daily install's stamp, which belongs
 * to a different build.
 */
function buildIdOfRunningTree(): string | undefined {
    try {
        const root = safeRealpath(thisProcessReleaseRoot());
        if (root === undefined || root === safeRealpath(packedReleaseRoot())) {
            return undefined;
        }
        return thisProcessBuildId();
    } catch {
        return undefined;
    }
}

function safeRealpath(path: string): string | undefined {
    try {
        return realpathSync(path);
    } catch {
        return undefined;
    }
}
