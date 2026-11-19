import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    checkRecordIdentity,
    processIsAlive,
    processStartStamp,
} from "../host/process-identity.ts";
import { readDesktopPackage, type DesktopPackage } from "./desktop-packages.ts";
import { defaultInstallPrefix, desktopPackageReferencesDirectory } from "./layout.ts";

// A running desktop writes one record for the package it loaded, so cleanup
// can tell a package in use from one that is only installed.
export interface DesktopPackageReference {
    readonly pid: number;
    readonly started_at: string;
    readonly start_stamp?: string;
    readonly host_build_id: string;
    readonly desktop_version: string;
}

export interface DesktopPackageHolds {
    readonly held: ReadonlySet<string>;
    // A live process's record could not be read, so any package may be in use.
    readonly unreadable: boolean;
}

export function desktopPackageKey(hostBuildId: string, desktopVersion: string): string {
    return `${hostBuildId}\0${desktopVersion}`;
}

function referencePath(pid: number, prefix: string): string {
    return join(desktopPackageReferencesDirectory(prefix), `${pid}.json`);
}

// Not atomic on purpose: a reader that sees a partial file treats it as unreadable and keeps everything.
export function writeDesktopPackageReference(
    reference: DesktopPackageReference,
    prefix = defaultInstallPrefix(),
): void {
    mkdirSync(desktopPackageReferencesDirectory(prefix), { recursive: true, mode: 0o755 });
    writeFileSync(referencePath(reference.pid, prefix), `${JSON.stringify(reference)}\n`);
}

// Record the package this process loaded, then confirm it is still there: cleanup renames a package aside before it re-reads the records.
// Returns the call that drops the record. Throws when the package was collected first; install it again.
export function holdDesktopPackage(
    desktopPackage: DesktopPackage,
    prefix = defaultInstallPrefix(),
): () => void {
    const stamp = processStartStamp(process.pid);
    writeDesktopPackageReference({
        pid: process.pid,
        started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        ...(stamp === undefined ? {} : { start_stamp: stamp }),
        host_build_id: desktopPackage.hostBuildId,
        desktop_version: desktopPackage.desktopVersion,
    }, prefix);
    const release = (): void => rmSync(referencePath(process.pid, prefix), { force: true });
    try {
        readDesktopPackage(desktopPackage.directory, desktopPackage);
    } catch (error) {
        release();
        throw error;
    }
    return release;
}

// Records of exited processes, and of a PID another program now holds, are deleted.
export function readDesktopPackageHolds(prefix = defaultInstallPrefix()): DesktopPackageHolds {
    const directory = desktopPackageReferencesDirectory(prefix);
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { held: new Set(), unreadable: false };
        throw error;
    }
    const held = new Set<string>();
    let unreadable = false;
    for (const name of names) {
        const match = /^(\d+)\.json$/.exec(name);
        if (match === null) continue;
        const pid = Number(match[1]);
        const path = join(directory, name);
        if (!processIsAlive(pid)) {
            rmSync(path, { force: true });
            continue;
        }
        const record = readReference(path, pid);
        if (record === undefined) {
            unreadable = true;
        } else if (checkRecordIdentity(record) === "mismatch") {
            rmSync(path, { force: true });
        } else {
            held.add(desktopPackageKey(record.host_build_id, record.desktop_version));
        }
    }
    return { held, unreadable };
}

function readReference(path: string, pid: number): DesktopPackageReference | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
        record.pid !== pid
        || typeof record.started_at !== "string"
        || typeof record.host_build_id !== "string" || record.host_build_id.length === 0
        || typeof record.desktop_version !== "string" || record.desktop_version.length === 0
        || (record.start_stamp !== undefined && typeof record.start_stamp !== "string")
    ) {
        return undefined;
    }
    return {
        pid,
        started_at: record.started_at,
        ...(record.start_stamp === undefined ? {} : { start_stamp: record.start_stamp }),
        host_build_id: record.host_build_id,
        desktop_version: record.desktop_version,
    };
}
