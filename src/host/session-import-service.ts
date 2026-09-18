import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import type { AssistantMessage, UserMessage } from "../model/types.ts";
import type { ImportedMessage, ParsedImport } from "../session-import/index.ts";
import type {
    ImportableSession,
    ImportableSessionList,
} from "../session-import/discover.ts";
import {
    writeImportedSession,
    type ImportedSessionMessage,
} from "../store/imported-session-writer.ts";
import { readSessionHeader } from "../store/session-store.ts";
import type { RegisteredAgentSummary } from "./agent-registry/support.ts";
import type { ImportableSessionEntry, SessionImportRejection } from "./protocol.ts";
import { parseSourceFileInChild } from "./session-import-source.ts";

export interface SessionImportSucceeded {
    readonly status: "imported";
    readonly sessionId: string;
    readonly sessionPath: string;
    // True when the same source file was imported before.
    readonly existing: boolean;
}

export interface SessionImportFailed {
    readonly status: "rejected";
    readonly reason: SessionImportRejection;
}

export type SessionImportOutcome = SessionImportSucceeded | SessionImportFailed;

export interface ImportSessionOptions {
    readonly sessionDirectory: string;
    readonly indexed: Iterable<RegisteredAgentSummary>;
    readonly now?: () => Date;
    readonly createSessionId?: () => string;
}

const MAX_NAME_BYTES = 200;

export async function importSessionFile(
    sourcePath: string,
    options: ImportSessionOptions,
): Promise<SessionImportOutcome> {
    const absolutePath = resolve(sourcePath);
    const source = await parseSourceFileInChild(absolutePath);
    if (source.status === "rejected") return source;
    const { parsed, sha256 } = source;
    const existing = await findExistingImport(parsed, sha256, options.indexed);
    if (existing !== undefined) {
        return {
            status: "imported",
            sessionId: existing.id,
            sessionPath: existing.session_path,
            existing: true,
        };
    }
    const now = options.now ?? (() => new Date());
    const sessionId = (options.createSessionId ?? randomUUID)();
    const sessionPath = join(options.sessionDirectory, `${sessionId}.jsonl`);
    const name = parsed.title === undefined ? undefined : sessionName(parsed.title);
    await writeImportedSession(sessionPath, {
        sessionId,
        cwd: parsed.cwd,
        provenance: {
            tool: parsed.tool,
            sourceSessionId: parsed.sourceSessionId,
            sourcePath: absolutePath,
            sourceSha256: sha256,
            sourceStartedAt: parsed.startedAt,
            importedAt: now().toISOString(),
        },
        messages: parsed.messages.map((message) => modelMessage(parsed, message)),
        ...(name === undefined ? {} : { name }),
        now,
    });
    return { status: "imported", sessionId, sessionPath, existing: false };
}

async function findExistingImport(
    parsed: ParsedImport,
    sha256: string,
    indexed: Iterable<RegisteredAgentSummary>,
): Promise<RegisteredAgentSummary | undefined> {
    for (const summary of indexed) {
        const imported = summary.imported_from;
        if (
            imported === undefined
            || imported.tool !== parsed.tool
            || imported.source_session_id !== parsed.sourceSessionId
        ) {
            continue;
        }
        try {
            const header = await readSessionHeader(summary.session_path);
            if (header.importedFrom?.sourceSha256 === sha256) return summary;
        } catch {
            // A session that cannot be read is not a match.
        }
    }
    return undefined;
}

export interface ImportableSessionListing {
    readonly sessions: readonly ImportableSessionEntry[];
    readonly truncated: boolean;
}

// Marks each listed session with the newest Vera session imported from it.
export function markImportedSessions(
    listed: ImportableSessionList,
    indexed: Iterable<RegisteredAgentSummary>,
): ImportableSessionListing {
    const newest = new Map<string, RegisteredAgentSummary>();
    for (const summary of indexed) {
        const imported = summary.imported_from;
        if (imported === undefined) continue;
        const key = `${imported.tool}\0${imported.source_session_id}`;
        const current = newest.get(key);
        if (current === undefined || (summary.created_at ?? "") > (current.created_at ?? "")) {
            newest.set(key, summary);
        }
    }
    return {
        sessions: listed.sessions.map((session) => importableSessionEntry(
            session,
            newest.get(`${session.tool}\0${session.sourceSessionId}`)?.id,
        )),
        truncated: listed.truncated,
    };
}

function importableSessionEntry(
    session: ImportableSession,
    importedSessionId: string | undefined,
): ImportableSessionEntry {
    return {
        tool: session.tool,
        path: session.path,
        source_session_id: session.sourceSessionId,
        workspace: session.workspace,
        updated_at: session.updatedAt,
        ...(session.startedAt === undefined ? {} : { started_at: session.startedAt }),
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.firstMessage === undefined ? {} : { first_message: session.firstMessage }),
        ...(importedSessionId === undefined ? {} : { imported_session_id: importedSessionId }),
    };
}

function modelMessage(
    parsed: ParsedImport,
    message: ImportedMessage,
): ImportedSessionMessage {
    if (message.role === "user") {
        const user: UserMessage = {
            role: "user",
            content: [{ type: "text", text: message.text }],
        };
        return { message: user, timestamp: message.timestamp };
    }
    // `api: "none"` keeps imported replies out of usage and cost totals.
    const assistant: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: message.text }],
        source: { provider: parsed.tool, api: "none", model: parsed.tool },
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
        },
        stopReason: "stop",
    };
    return { message: assistant, timestamp: message.timestamp };
}

function sessionName(title: string): string | undefined {
    let name = title.replaceAll(/\s+/g, " ").replaceAll("\0", "").trim();
    while (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
        name = name.slice(0, -1).trimEnd();
    }
    return name.length === 0 ? undefined : name;
}
