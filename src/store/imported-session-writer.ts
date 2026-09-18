import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { AssistantMessage, UserMessage } from "../model/types.ts";
import type { SessionImportProvenance } from "./session-import-provenance.ts";
import {
    SESSION_FORMAT_VERSION,
    SessionStore,
    type SessionHeader,
    type SessionMessageEntry,
    type SessionNameEntry,
} from "./session-store.ts";

export interface ImportedSessionMessage {
    readonly message: UserMessage | AssistantMessage;
    readonly timestamp: string;
}

export interface WriteImportedSessionOptions {
    readonly sessionId: string;
    readonly cwd: string;
    readonly provenance: Omit<SessionImportProvenance, "lastMessageId" | "messageCount">;
    readonly messages: readonly ImportedSessionMessage[];
    readonly name?: string;
    readonly now?: () => Date;
    readonly createId?: () => string;
}

// Writes the whole session beside its final path, reopens it through the
// store, then links it into place, so a failure leaves no partial session.
export async function writeImportedSession(
    path: string,
    options: WriteImportedSessionOptions,
): Promise<SessionStore> {
    if (options.messages.length === 0) {
        throw new Error("Cannot import a session with no messages");
    }
    const now = options.now ?? (() => new Date());
    const createId = options.createId ?? randomUUID;
    const entries: SessionMessageEntry[] = [];
    let parentId: string | null = null;
    for (const imported of options.messages) {
        const entry: SessionMessageEntry = {
            type: "message",
            id: createId(),
            parentId,
            timestamp: imported.timestamp,
            message: imported.message,
        };
        entries.push(entry);
        parentId = entry.id;
    }
    const header: SessionHeader = {
        type: "session",
        version: SESSION_FORMAT_VERSION,
        id: options.sessionId,
        timestamp: now().toISOString(),
        cwd: options.cwd,
        importedFrom: {
            ...options.provenance,
            messageCount: entries.length,
            lastMessageId: entries[entries.length - 1]!.id,
        },
    };
    const records: object[] = [header, ...entries];
    if (options.name !== undefined) {
        const nameEntry: SessionNameEntry = {
            type: "session_name",
            timestamp: header.timestamp,
            name: options.name,
        };
        records.push(nameEntry);
    }

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const staged = `${path}.import-${randomUUID()}.tmp`;
    try {
        const file = await open(staged, "wx", 0o600);
        try {
            await file.writeFile(
                records.map((record) => `${JSON.stringify(record)}\n`).join(""),
                "utf8",
            );
            await file.sync();
        } finally {
            await file.close();
        }
        await SessionStore.open(staged);
        await link(staged, path);
    } finally {
        await rm(staged, { force: true });
    }
    return SessionStore.open(path);
}
