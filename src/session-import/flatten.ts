import type { ImportedMessage } from "./types.ts";

const RESULT_MAX_LINES = 20;
const RESULT_MAX_BYTES = 2_048;
const ARGUMENT_MAX_CHARS = 200;

export const IMAGE_PLACEHOLDER = "[image]";

export function formatSize(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    return `${Math.round(bytes / 1_024)} KB`;
}

export function toolResultExcerpt(output: string, isError: boolean): string {
    const text = output.replace(/\s+$/, "");
    const totalBytes = Buffer.byteLength(text, "utf8");
    let excerpt = text.split("\n").slice(0, RESULT_MAX_LINES).join("\n");
    if (Buffer.byteLength(excerpt, "utf8") > RESULT_MAX_BYTES) {
        // Cut on a code point so a multi-byte character is never split.
        let bytes = 0;
        let cut = 0;
        for (const char of excerpt) {
            const size = Buffer.byteLength(char, "utf8");
            if (bytes + size > RESULT_MAX_BYTES) break;
            bytes += size;
            cut += char.length;
        }
        excerpt = excerpt.slice(0, cut);
    }
    const truncated = excerpt.length < text.length
        ? `${excerpt}\n[truncated, ${formatSize(totalBytes)}]`
        : excerpt;
    return isError ? `[tool error] ${truncated}` : truncated;
}

function firstLine(value: string): string {
    return value.split("\n", 1)[0]!.trim();
}

function cut(value: string): string {
    return value.length > ARGUMENT_MAX_CHARS
        ? value.slice(0, ARGUMENT_MAX_CHARS)
        : value;
}

function patchFiles(patch: string): string | undefined {
    const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
        .map((match) => match[1]!.trim());
    return files.length === 0 ? undefined : files.join(", ");
}

function stringField(
    input: Readonly<Record<string, unknown>>,
    key: string,
): string | undefined {
    const value = input[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mainArgument(input: unknown): string {
    if (typeof input === "string") {
        return cut(patchFiles(input) ?? firstLine(input));
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return cut(JSON.stringify(input) ?? "");
    }
    const record = input as Readonly<Record<string, unknown>>;
    const path = stringField(record, "file_path") ?? stringField(record, "notebook_path");
    if (path !== undefined) return cut(path);
    const command = record.command ?? record.cmd;
    if (typeof command === "string" && command.length > 0) {
        return cut(firstLine(command));
    }
    if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
        return cut(firstLine(command.join(" ")));
    }
    const pattern = stringField(record, "pattern");
    if (pattern !== undefined) return cut(pattern);
    const patch = stringField(record, "input") ?? stringField(record, "patch");
    const files = patch === undefined ? undefined : patchFiles(patch);
    if (files !== undefined) return cut(files);
    return cut(JSON.stringify(record));
}

export function toolCallLine(name: string, input: unknown): string {
    const argument = mainArgument(input);
    return argument.length === 0 ? `[tool] ${name}` : `[tool] ${name} ${argument}`;
}

interface Span {
    readonly role: "user" | "assistant";
    readonly parts: string[];
    readonly timestamp: string;
}

// Collects flattened parts in source order and merges same-role neighbours,
// so the result alternates strictly and starts with a user message.
export class MessageBuilder {
    private readonly spans: Span[] = [];

    add(role: "user" | "assistant", text: string, timestamp: string): void {
        const trimmed = text.trim();
        if (trimmed.length === 0) return;
        const last = this.spans.at(-1);
        if (last !== undefined && last.role === role) {
            last.parts.push(trimmed);
            return;
        }
        if (last === undefined && role === "assistant") return;
        this.spans.push({ role, parts: [trimmed], timestamp });
    }

    messages(): readonly ImportedMessage[] {
        return this.spans.map((span) => ({
            role: span.role,
            text: span.parts.join("\n\n"),
            timestamp: span.timestamp,
        }));
    }
}
