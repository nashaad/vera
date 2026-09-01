import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";

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
        }
        throw error;
    }
}

function sqlStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}
