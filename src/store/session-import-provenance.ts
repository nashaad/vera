export type SessionImportTool = "claude-code" | "codex";

export interface SessionImportProvenance {
    readonly tool: SessionImportTool;
    readonly sourceSessionId: string;
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly sourceStartedAt: string;
    readonly importedAt: string;
    readonly messageCount: number;
    readonly lastMessageId: string;
}

export function isSessionImportTool(value: unknown): value is SessionImportTool {
    return value === "claude-code" || value === "codex";
}

export function isSessionImportProvenance(
    value: unknown,
): value is SessionImportProvenance {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return isSessionImportTool(record.tool)
        && nonEmptyString(record.sourceSessionId)
        && nonEmptyString(record.sourcePath)
        && typeof record.sourceSha256 === "string"
        && /^[0-9a-f]{64}$/.test(record.sourceSha256)
        && nonEmptyString(record.sourceStartedAt)
        && nonEmptyString(record.importedAt)
        && typeof record.messageCount === "number"
        && Number.isInteger(record.messageCount)
        && record.messageCount > 0
        && nonEmptyString(record.lastMessageId);
}

export function importToolLabel(tool: SessionImportTool): string {
    return tool === "claude-code" ? "Claude Code" : "Codex";
}

export function importedSessionLabel(tool: SessionImportTool): string {
    return `[imported · ${importToolLabel(tool)}]`;
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}
