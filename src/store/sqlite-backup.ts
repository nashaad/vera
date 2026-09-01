import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";

/**
 * Copy one live SQLite database to `destinationPath` through SQLite's own
 * backup, not by copying the main file.
 *
 * Inbox and schedules use WAL. Copying `*.db` while the WAL holds newer pages
 * yields a destination that is missing those commits, or that cannot even
 * open. `VACUUM INTO` reads the live connection, so WAL pages are included.
 */
export function backupSqliteDatabase(
    source: Database,
    destinationPath: string,
): void {
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    const staging = `${destinationPath}.${randomUUID()}.tmp`;
    try {
        source.exec(`VACUUM INTO ${sqlStringLiteral(staging)}`);
        renameSync(staging, destinationPath);
    } catch (error) {
        try {
            unlinkSync(staging);
        } catch {
            // Staging may not have been created.
        }
        throw error;
    }
}

function sqlStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}
