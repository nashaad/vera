import { mkdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { UserFacingError } from "../user-facing-error.ts";

export interface StoreCheckpoint {
    readonly takenAt: string;
    readonly databases: readonly string[];
}

interface BackupTarget {
    backupTo(destinationPath: string): void;
}

export function checkpointOpenStores(options: {
    readonly destination: string;
    readonly inbox: BackupTarget | null;
    readonly schedules: BackupTarget | null;
}): StoreCheckpoint {
    if (!isAbsolute(options.destination) || options.destination.includes("\0")) {
        throw new UserFacingError(
            "Checkpoint destination must be an absolute path.",
        );
    }
    mkdirSync(options.destination, { recursive: true, mode: 0o700 });
    const databases: string[] = [];
    try {
        if (options.inbox !== null) {
            options.inbox.backupTo(join(options.destination, "inbox.db"));
            databases.push("inbox.db");
        }
        if (options.schedules !== null) {
            options.schedules.backupTo(
                join(options.destination, "schedules.db"),
            );
            databases.push("schedules.db");
        }
    } catch (error) {
        for (const name of databases) {
            try {
                unlinkSync(join(options.destination, name));
            } catch {
            }
        }
        throw error;
    }
    return {
        takenAt: new Date().toISOString(),
        databases,
    };
}
