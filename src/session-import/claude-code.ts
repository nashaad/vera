import {
    IMAGE_PLACEHOLDER,
    MessageBuilder,
    toolCallLine,
    toolResultExcerpt,
} from "./flatten.ts";
import {
    ImportRejectedError,
    type ParsedImport,
    type SourceRecord,
} from "./types.ts";

const INJECTED_BLOCKS = [
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
];

const INJECTED_PREFIXES = [
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<task-notification>",
    "[Request interrupted",
];

// Large fields no parser reads. A long session carries tens of megabytes of them.
const UNREAD_FIELDS = ["toolUseResult", "attachment", "snapshot", "rendered", "wireToolInputs"];

export function withoutUnreadFields(record: SourceRecord): SourceRecord {
    if (!UNREAD_FIELDS.some((field) => field in record)) return record;
    const kept: Record<string, unknown> = { ...record };
    for (const field of UNREAD_FIELDS) delete kept[field];
    return kept;
}

export function isClaudeCodeRecord(record: SourceRecord): boolean {
    return (record.type === "user" || record.type === "assistant")
        && typeof record.sessionId === "string"
        && typeof record.message === "object"
        && record.message !== null;
}

// Returns undefined when the text was put there by the harness, not typed.
function typedText(text: string): string | undefined {
    let cleaned = text;
    for (const block of INJECTED_BLOCKS) cleaned = cleaned.replace(block, "");
    cleaned = cleaned.trim();
    if (cleaned.length === 0) return undefined;
    if (INJECTED_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) return undefined;
    if (/^<cross-session-message\b/m.test(cleaned)) return undefined;
    return cleaned;
}

function stringOf(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => {
        const value = part as SourceRecord;
        if (value.type === "text") return stringOf(value.text) ?? "";
        if (value.type === "image") return IMAGE_PLACEHOLDER;
        return "";
    }).filter((text) => text.length > 0).join("\n");
}

function isMainTurn(record: SourceRecord): boolean {
    return isClaudeCodeRecord(record) && record.isSidechain !== true;
}

// A compact boundary's logicalParentUuid can point at a record written after
// the boundary, which loops back to it. Only an earlier record is trusted;
// otherwise the last main turn before the boundary is the pre-compaction leaf.
function boundaryParent(
    records: readonly SourceRecord[],
    boundaryAt: number,
    positions: ReadonlyMap<string, number>,
): number | undefined {
    const logical = stringOf(records[boundaryAt]!.logicalParentUuid);
    const logicalAt = logical === undefined ? undefined : positions.get(logical);
    if (logicalAt !== undefined && logicalAt < boundaryAt) return logicalAt;
    for (let index = boundaryAt - 1; index >= 0; index -= 1) {
        if (isMainTurn(records[index]!)) return index;
    }
    return undefined;
}

// Follows the parent chain back from the last message, stepping over compact
// boundaries, so rewound branches are left out.
function activeChain(records: readonly SourceRecord[]): readonly SourceRecord[] {
    const positions = new Map<string, number>();
    records.forEach((record, index) => {
        const id = stringOf(record.uuid);
        if (id !== undefined) positions.set(id, index);
    });
    const chain: SourceRecord[] = [];
    const seen = new Set<number>();
    let at: number | undefined = records.findLastIndex(isMainTurn);
    while (at !== undefined && at !== -1 && !seen.has(at)) {
        seen.add(at);
        const current: SourceRecord = records[at]!;
        chain.push(current);
        const parent = stringOf(current.parentUuid);
        at = parent !== undefined
            ? positions.get(parent)
            : current.logicalParentUuid !== undefined
                ? boundaryParent(records, at, positions)
                : undefined;
    }
    return chain.reverse();
}

export function claudeCodeTitle(records: readonly SourceRecord[]): string | undefined {
    const pick = (type: string, key: string): string | undefined => {
        const record = records.findLast((value) =>
            value.type === type && typeof value[key] === "string"
        );
        const text = record === undefined ? undefined : (record[key] as string).trim();
        return text === undefined || text.length === 0 ? undefined : text;
    };
    return pick("custom-title", "customTitle")
        ?? pick("ai-title", "aiTitle")
        ?? pick("summary", "summary");
}

function addUserContent(
    builder: MessageBuilder,
    content: unknown,
    timestamp: string,
): void {
    if (typeof content === "string") {
        const text = typedText(content);
        if (text !== undefined) builder.add("user", text, timestamp);
        return;
    }
    if (!Array.isArray(content)) return;
    for (const part of content) {
        const value = part as SourceRecord;
        if (value.type === "text") {
            const text = typedText(stringOf(value.text) ?? "");
            if (text !== undefined) builder.add("user", text, timestamp);
        } else if (value.type === "image") {
            builder.add("user", IMAGE_PLACEHOLDER, timestamp);
        } else if (value.type === "tool_result") {
            builder.add(
                "assistant",
                toolResultExcerpt(toolResultText(value.content), value.is_error === true),
                timestamp,
            );
        }
    }
}

function addAssistantContent(
    builder: MessageBuilder,
    content: unknown,
    timestamp: string,
): void {
    if (typeof content === "string") {
        builder.add("assistant", content, timestamp);
        return;
    }
    if (!Array.isArray(content)) return;
    for (const part of content) {
        const value = part as SourceRecord;
        if (value.type === "text") {
            builder.add("assistant", stringOf(value.text) ?? "", timestamp);
        } else if (value.type === "tool_use") {
            builder.add(
                "assistant",
                toolCallLine(stringOf(value.name) ?? "unknown", value.input),
                timestamp,
            );
        }
    }
}

export function parseClaudeCode(records: readonly SourceRecord[]): ParsedImport {
    const chain = activeChain(records).filter(isClaudeCodeRecord);
    const builder = new MessageBuilder();
    for (const record of chain) {
        if (
            record.isSidechain === true
            || record.isMeta === true
            || record.isCompactSummary === true
        ) {
            continue;
        }
        const message = record.message as SourceRecord;
        const timestamp = stringOf(record.timestamp) ?? "";
        if (record.type === "user") {
            addUserContent(builder, message.content, timestamp);
        } else {
            addAssistantContent(builder, message.content, timestamp);
        }
    }
    const messages = builder.messages();
    const first = chain[0];
    if (messages.length === 0 || first === undefined) {
        throw new ImportRejectedError("empty", "The session has no messages to import.");
    }
    const found = claudeCodeTitle(records);
    return {
        tool: "claude-code",
        sourceSessionId: stringOf(first.sessionId) ?? "",
        cwd: stringOf(chain.find((record) => typeof record.cwd === "string")?.cwd) ?? "",
        startedAt: stringOf(first.timestamp) ?? messages[0]!.timestamp,
        ...(found === undefined ? {} : { title: found }),
        messages,
    };
}
