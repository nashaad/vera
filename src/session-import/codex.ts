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

const INJECTED_PREFIXES = [
    "<environment_context>",
    "# AGENTS.md instructions",
    "<user_instructions>",
    "<INSTRUCTIONS>",
    "<recommended_plugins>",
    "<permissions instructions>",
    "<skills_instructions>",
    "<collaboration_mode>",
    "<turn_aborted>",
    "<user_shell_command>",
    "<image name=",
    "</image>",
];

// Exec output arrives behind a few metadata lines ending in "Output:".
const OUTPUT_HEADER_MAX_LINES = 8;

interface ToolOutput {
    readonly text: string;
    readonly isError: boolean;
}

function payloadOf(record: SourceRecord): SourceRecord | undefined {
    const payload = record.payload;
    return typeof payload === "object" && payload !== null
        ? payload as SourceRecord
        : undefined;
}

function stringOf(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function isCodexMeta(record: SourceRecord): boolean {
    return record.type === "session_meta"
        && typeof payloadOf(record)?.id === "string";
}

function typedText(text: string): string | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    if (INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return undefined;
    return trimmed;
}

function stripOutputHeader(text: string): { readonly text: string; readonly exitCode?: number } {
    const lines = text.split("\n");
    const outputAt = lines.slice(0, OUTPUT_HEADER_MAX_LINES)
        .findIndex((line) => line.trim() === "Output:");
    if (outputAt === -1) return { text };
    const header = lines.slice(0, outputAt).join("\n");
    const code = /(?:exited with code|Exit code:)\s*(-?\d+)/.exec(header)?.[1];
    return {
        text: lines.slice(outputAt + 1).join("\n"),
        ...(code === undefined ? {} : { exitCode: Number(code) }),
    };
}

function outputText(output: unknown): { readonly text: string; readonly exitCode?: number } {
    if (Array.isArray(output)) {
        const joined = output.map((part) => {
            const value = part as SourceRecord;
            if (value.type === "input_image") return IMAGE_PLACEHOLDER;
            return stringOf(value.text) ?? "";
        }).join("");
        return stripOutputHeader(joined);
    }
    const raw = stringOf(output) ?? "";
    if (raw.trimStart().startsWith("{")) {
        try {
            const parsed = JSON.parse(raw) as SourceRecord;
            const inner = stringOf(parsed.output);
            if (inner !== undefined) {
                const metadata = parsed.metadata as SourceRecord | undefined;
                const code = metadata?.exit_code;
                return {
                    text: inner,
                    ...(typeof code === "number" ? { exitCode: code } : {}),
                };
            }
        } catch {
            // Not the JSON wrapper; fall through to plain text.
        }
    }
    return stripOutputHeader(raw);
}

function toolOutput(payload: SourceRecord): ToolOutput {
    const { text, exitCode } = outputText(payload.output);
    const failed = (exitCode !== undefined && exitCode !== 0)
        || payload.status === "failed";
    return { text, isError: failed };
}

function callInput(payload: SourceRecord): unknown {
    if (payload.type === "custom_tool_call") return payload.input;
    if (payload.type === "local_shell_call") {
        return (payload.action as SourceRecord | undefined) ?? {};
    }
    const args = stringOf(payload.arguments);
    if (args === undefined) return payload.arguments;
    try {
        return JSON.parse(args) as unknown;
    } catch {
        return args;
    }
}

function addMessage(
    builder: MessageBuilder,
    payload: SourceRecord,
    timestamp: string,
): void {
    const content = Array.isArray(payload.content) ? payload.content : [];
    if (payload.role === "user") {
        for (const part of content) {
            const value = part as SourceRecord;
            if (value.type === "input_image") {
                builder.add("user", IMAGE_PLACEHOLDER, timestamp);
                continue;
            }
            const text = typedText(stringOf(value.text) ?? "");
            if (text !== undefined) builder.add("user", text, timestamp);
        }
    } else if (payload.role === "assistant") {
        for (const part of content) {
            builder.add("assistant", stringOf((part as SourceRecord).text) ?? "", timestamp);
        }
    }
}

// Takes records one at a time, so a large rollout is never held whole.
export class CodexParser {
    private meta: SourceRecord | undefined;
    private firstTimestamp: string | undefined;
    private readonly builder = new MessageBuilder();

    add(record: SourceRecord): void {
        if (this.firstTimestamp === undefined) this.firstTimestamp = stringOf(record.timestamp);
        if (this.meta === undefined && isCodexMeta(record)) this.meta = payloadOf(record);
        if (record.type !== "response_item") return;
        const payload = payloadOf(record);
        if (payload === undefined) return;
        const builder = this.builder;
        const timestamp = stringOf(record.timestamp) ?? "";
        switch (payload.type) {
            case "message":
                addMessage(builder, payload, timestamp);
                break;
            case "function_call":
            case "custom_tool_call":
                builder.add(
                    "assistant",
                    toolCallLine(stringOf(payload.name) ?? "unknown", callInput(payload)),
                    timestamp,
                );
                break;
            case "local_shell_call":
                builder.add("assistant", toolCallLine("shell", callInput(payload)), timestamp);
                break;
            case "function_call_output":
            case "custom_tool_call_output":
            case "local_shell_call_output": {
                const output = toolOutput(payload);
                builder.add("assistant", toolResultExcerpt(output.text, output.isError), timestamp);
                break;
            }
            default:
                break;
        }
    }

    finish(): ParsedImport {
        const meta = this.meta;
        if (meta === undefined) {
            throw new ImportRejectedError("unrecognized", "The file is not a Claude Code or Codex session.");
        }
        const messages = this.builder.messages();
        if (messages.length === 0) {
            throw new ImportRejectedError("empty", "The session has no messages to import.");
        }
        return {
            tool: "codex",
            sourceSessionId: stringOf(meta.id)!,
            cwd: stringOf(meta.cwd) ?? "",
            startedAt: stringOf(meta.timestamp) ?? this.firstTimestamp ?? messages[0]!.timestamp,
            messages,
        };
    }
}
