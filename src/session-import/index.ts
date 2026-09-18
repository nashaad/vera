import {
    claudeCodeTitle,
    isClaudeCodeRecord,
    parseClaudeCode,
    withoutUnreadFields,
} from "./claude-code.ts";
import { CodexParser, isCodexMeta } from "./codex.ts";
import {
    ImportRejectedError,
    type ImportSourceTool,
    type ParsedImport,
    type SourceRecord,
} from "./types.ts";

export {
    ImportRejectedError,
    type ImportedAssistantMessage,
    type ImportedMessage,
    type ImportedUserMessage,
    type ImportRejectionReason,
    type ImportSourceTool,
    type ParsedImport,
} from "./types.ts";

// Codex compaction records repeat the whole history and can be most of the
// file. No parser reads them or Codex events.
const UNREAD_TYPES = new Set(["compacted", "event_msg"]);

// Codex writes the record type first, so these lines skip JSON.parse.
const UNREAD_CODEX_LINE = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"(?:compacted|event_msg)"/;

// Returns undefined for a blank, torn, foreign or unread line.
export function parseSourceLine(line: string): SourceRecord | undefined {
    if (line.trim().length === 0 || UNREAD_CODEX_LINE.test(line)) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as SourceRecord;
    return typeof record.type === "string" && UNREAD_TYPES.has(record.type) ? undefined : record;
}

function readRecords(source: string): readonly SourceRecord[] {
    const records: SourceRecord[] = [];
    for (const line of source.split("\n")) {
        const record = parseSourceLine(line);
        if (record !== undefined) records.push(record);
    }
    return records;
}

export function parseImportSource(source: string): ParsedImport {
    const reader = new ImportSourceReader();
    for (const line of source.split("\n")) reader.addLine(line);
    return reader.finish();
}

// Codex records go straight into its parser. Claude Code records are all kept,
// since its active branch is known only from the last one.
export class ImportSourceReader {
    private codex: CodexParser | undefined;
    private pending: SourceRecord[] = [];

    addLine(line: string): void {
        const record = parseSourceLine(line);
        if (record === undefined) return;
        if (this.codex !== undefined) {
            this.codex.add(record);
            return;
        }
        if (isCodexMeta(record)) {
            const codex = new CodexParser();
            for (const earlier of this.pending) codex.add(earlier);
            this.pending = [];
            codex.add(record);
            this.codex = codex;
            return;
        }
        this.pending.push(withoutUnreadFields(record));
    }

    finish(): ParsedImport {
        if (this.codex !== undefined) return this.codex.finish();
        if (this.pending.some(isClaudeCodeRecord)) return parseClaudeCode(this.pending);
        throw new ImportRejectedError(
            "unrecognized",
            "The file is not a Claude Code or Codex session.",
        );
    }
}

export interface ImportProbe {
    readonly tool: ImportSourceTool;
    readonly sourceSessionId: string;
    readonly cwd: string;
    readonly startedAt?: string;
    readonly title?: string;
    readonly firstMessage?: string;
    // Codex records the rollouts of its own subagents beside the user's sessions.
    readonly subagent?: true;
}

function stringField(record: SourceRecord | undefined, key: string): string | undefined {
    const value = record?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCodexSubagent(meta: SourceRecord): boolean {
    const source = meta.source;
    return typeof source === "object" && source !== null && "subagent" in source;
}

// Reads what a picker row needs from the start of a session file, and from
// its end when given, since a Claude Code title is often written last.
// Returns undefined for a file that is not a session.
export function probeImportSource(head: string, tail = ""): ImportProbe | undefined {
    const records = readRecords(head);
    let parsed: ParsedImport | undefined;
    try {
        parsed = parseImportSource(head);
    } catch (error) {
        if (!(error instanceof ImportRejectedError) || error.reason !== "empty") return undefined;
    }
    const firstMessage = parsed?.messages.find((message) => message.role === "user")?.text;
    const preview = firstMessage === undefined ? {} : { firstMessage };
    const meta = records.find(isCodexMeta);
    if (meta !== undefined) {
        const payload = meta.payload as SourceRecord;
        const startedAt = stringField(payload, "timestamp") ?? stringField(meta, "timestamp");
        return {
            tool: "codex",
            sourceSessionId: stringField(payload, "id")!,
            cwd: stringField(payload, "cwd") ?? "",
            ...(startedAt === undefined ? {} : { startedAt }),
            ...preview,
            ...(isCodexSubagent(payload) ? { subagent: true } : {}),
        };
    }
    const first = records.find(isClaudeCodeRecord);
    if (first === undefined) return undefined;
    const title = claudeCodeTitle([...records, ...readRecords(tail)]);
    const startedAt = parsed?.startedAt ?? stringField(first, "timestamp");
    return {
        tool: "claude-code",
        sourceSessionId: parsed?.sourceSessionId ?? stringField(first, "sessionId")!,
        cwd: parsed?.cwd
            || stringField(records.find((record) => typeof record.cwd === "string"), "cwd")
            || "",
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(title === undefined ? {} : { title }),
        ...preview,
    };
}
