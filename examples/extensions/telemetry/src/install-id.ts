import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSTALL_ID_FILE = "install-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One random id per profile, created on first activation. A read or write
 * failure still yields an id for this process; telemetry is not worth
 * failing a host start over.
 */
export function readOrCreateInstallId(directory: string): string {
    const file = join(directory, INSTALL_ID_FILE);
    try {
        const existing = readFileSync(file, "utf8").trim();
        if (UUID.test(existing)) return existing;
    } catch {
        // No id yet, or an unreadable file: make a new one below.
    }
    const id = randomUUID();
    try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(file, `${id}\n`, { mode: 0o600 });
    } catch {
        // The id still labels this process's events.
    }
    return id;
}
