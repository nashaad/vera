export type ImportSourceTool = "claude-code" | "codex";

export interface ImportedUserMessage {
    readonly role: "user";
    readonly text: string;
    readonly timestamp: string;
}

export interface ImportedAssistantMessage {
    readonly role: "assistant";
    readonly text: string;
    readonly timestamp: string;
}

export type ImportedMessage = ImportedUserMessage | ImportedAssistantMessage;

export interface ParsedImport {
    readonly tool: ImportSourceTool;
    readonly sourceSessionId: string;
    readonly cwd: string;
    readonly startedAt: string;
    readonly title?: string;
    readonly messages: readonly ImportedMessage[];
}

export type ImportRejectionReason = "unrecognized" | "empty";

export class ImportRejectedError extends Error {
    readonly reason: ImportRejectionReason;

    constructor(reason: ImportRejectionReason, message: string) {
        super(message);
        this.name = "ImportRejectedError";
        this.reason = reason;
    }
}

export type SourceRecord = Readonly<Record<string, unknown>>;
