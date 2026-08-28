import { createHash, randomUUID } from "node:crypto";
import {
    link,
    mkdir,
    open,
    readFile,
    rm,
} from "node:fs/promises";
import { join } from "node:path";

export type SessionIdentityReservationOutcome =
    | "reserved"
    | "owned"
    | "taken";

interface SessionIdentityReservation {
    readonly version: 1;
    readonly session_id: string;
    readonly key: string;
}

/**
 * Claims an identity key permanently inside one session directory.
 *
 * The completed temporary file is hard-linked into place, so another host
 * sees either the whole reservation or no reservation. A session retains its
 * claim after it closes or is trashed; durable identities are never recycled.
 */
export async function reserveSessionIdentity(
    sessionDirectory: string,
    sessionId: string,
    key: string,
): Promise<SessionIdentityReservationOutcome> {
    const directory = join(sessionDirectory, ".identities");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncDirectory(sessionDirectory);
    const digest = createHash("sha256").update(key).digest("hex");
    const reservationPath = join(directory, `${digest}.json`);
    const temporaryPath = join(
        directory,
        `.${digest}.${randomUUID()}.tmp`,
    );
    const reservation: SessionIdentityReservation = {
        version: 1,
        session_id: sessionId,
        key,
    };
    const file = await open(temporaryPath, "wx", 0o600);
    try {
        await file.writeFile(`${JSON.stringify(reservation)}\n`, "utf8");
        await file.sync();
    } finally {
        await file.close();
    }
    try {
        await link(temporaryPath, reservationPath);
        await syncDirectory(directory);
        return "reserved";
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
        const existing = parseReservation(
            reservationPath,
            await readFile(reservationPath, "utf8"),
        );
        return existing.session_id === sessionId && existing.key === key
            ? "owned"
            : "taken";
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function parseReservation(
    path: string,
    source: string,
): SessionIdentityReservation {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new Error(`Invalid session identity reservation: ${path}`);
    }
    if (
        typeof value !== "object"
        || value === null
        || (value as SessionIdentityReservation).version !== 1
        || typeof (value as SessionIdentityReservation).session_id !== "string"
        || typeof (value as SessionIdentityReservation).key !== "string"
    ) {
        throw new Error(`Invalid session identity reservation: ${path}`);
    }
    return value as SessionIdentityReservation;
}
