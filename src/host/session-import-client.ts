import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { connectHost } from "./connection.ts";
import { isSessionImportTool } from "../store/session-import-provenance.ts";
import type { ImportableSessionEntry, SessionImportRejection } from "./protocol.ts";
import type {
    ImportableSessionListing,
    SessionImportOutcome,
} from "./session-import-service.ts";

export async function importSessionThroughHost(
    socketPath: string,
    path: string,
): Promise<SessionImportOutcome> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send({
                type: "import_session",
                path: resolveImportPath(path),
            });
            const response = asRecord(await connection.receive());
            if (
                response?.type === "session_imported"
                && typeof response.agent_id === "string"
                && response.agent_id.length > 0
                && typeof response.session_path === "string"
                && response.session_path.length > 0
                && typeof response.existing === "boolean"
            ) {
                return {
                    status: "imported",
                    sessionId: response.agent_id,
                    sessionPath: response.session_path,
                    existing: response.existing,
                };
            }
            if (
                response?.type === "session_import_rejected"
                && isImportRejection(response.reason)
            ) {
                return { status: "rejected", reason: response.reason };
            }
            throw new Error("Host returned an invalid session import response");
        } finally {
            connection.close();
        }
    } catch {
        return { status: "rejected", reason: "failed" };
    }
}

// Returns undefined when the host cannot be reached or answers badly.
export async function listImportableSessionsThroughHost(
    socketPath: string,
    workspace?: string,
): Promise<ImportableSessionListing | undefined> {
    try {
        const connection = await connectHost({ socketPath });
        try {
            await connection.send(workspace === undefined
                ? { type: "list_importable_sessions" }
                : { type: "list_importable_sessions", workspace });
            const response = asRecord(await connection.receive());
            if (
                response?.type !== "importable_sessions"
                || !Array.isArray(response.sessions)
                || typeof response.truncated !== "boolean"
            ) {
                return undefined;
            }
            const sessions: ImportableSessionEntry[] = [];
            for (const value of response.sessions) {
                const session = importableSessionEntry(value);
                if (session === undefined) return undefined;
                sessions.push(session);
            }
            return { sessions, truncated: response.truncated };
        } finally {
            connection.close();
        }
    } catch {
        return undefined;
    }
}

function importableSessionEntry(value: unknown): ImportableSessionEntry | undefined {
    const record = asRecord(value);
    if (
        record === undefined
        || !isSessionImportTool(record.tool)
        || !isFilledString(record.path)
        || !isFilledString(record.source_session_id)
        || typeof record.workspace !== "string"
        || !isFilledString(record.updated_at)
    ) {
        return undefined;
    }
    const optional = ["started_at", "title", "first_message", "imported_session_id"] as const;
    if (optional.some((key) => record[key] !== undefined && typeof record[key] !== "string")) {
        return undefined;
    }
    const text = (key: typeof optional[number]): string | undefined => record[key] as string | undefined;
    const startedAt = text("started_at");
    const title = text("title");
    const firstMessage = text("first_message");
    const importedSessionId = text("imported_session_id");
    return {
        tool: record.tool,
        path: record.path,
        source_session_id: record.source_session_id,
        workspace: record.workspace,
        updated_at: record.updated_at,
        ...(startedAt === undefined ? {} : { started_at: startedAt }),
        ...(title === undefined ? {} : { title }),
        ...(firstMessage === undefined ? {} : { first_message: firstMessage }),
        ...(importedSessionId === undefined ? {} : { imported_session_id: importedSessionId }),
    };
}

function isFilledString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

export function describeImportRejection(
    path: string,
    reason: SessionImportRejection,
): string {
    switch (reason) {
        case "unreadable":
            return `Cannot read ${path}.`;
        case "unrecognized":
            return `${path} is not a Claude Code or Codex session.`;
        case "empty":
            return `${path} has no messages to import.`;
        case "failed":
            return `Could not import ${path}. Check that the Vera host is running.`;
    }
}

// The host runs elsewhere, so a relative path must be settled here.
export function resolveImportPath(path: string, cwd = process.cwd()): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return join(homedir(), path.slice(2));
    return isAbsolute(path) ? path : resolve(cwd, path);
}

function isImportRejection(value: unknown): value is SessionImportRejection {
    return value === "unreadable"
        || value === "unrecognized"
        || value === "empty"
        || value === "failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
