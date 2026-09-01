import { readFileSync } from "node:fs";

import type {
    ModelMessage,
    ToolCallContent,
    ToolResultMessage,
} from "../model/types.ts";
import { TOOL_RESULT_VERBATIM_FLOOR_BYTES } from "../model/types.ts";
import { TOOL_RESULT_CEILING_BYTES } from "../tools/tool-result-limit.ts";
import { measureMessages } from "./context-measurement.ts";

export const TOOL_RESULT_STUB_AFTER_TURNS = 3;

/** Several legal per-result outputs must not compose one enormous request. */
export const TOOL_RESULT_TOTAL_BUDGET_BYTES = 128 * 1024;

export type ToolResultAgingLevel = "relaxed" | "normal" | "tight";

export interface ToolResultAgingLevelSettings {
    readonly gateFraction: number;
    readonly ageAfterTurns: number;
    readonly ageReads: boolean;
}

export const TOOL_RESULT_AGING_LEVELS: Readonly<
    Record<ToolResultAgingLevel, ToolResultAgingLevelSettings>
> = {
    relaxed: { gateFraction: 0.8, ageAfterTurns: 5, ageReads: false },
    normal: { gateFraction: 0.6, ageAfterTurns: 3, ageReads: true },
    tight: { gateFraction: 0.4, ageAfterTurns: 3, ageReads: true },
};

export const RELAXED_AGING_MIN_CAPACITY = 400_000;
export const NORMAL_AGING_MIN_CAPACITY = 128_000;

const UNKNOWN_CAPACITY_TOKENS = 100_000;

export function toolResultAgingLevel(
    capacity: number | undefined,
): ToolResultAgingLevel {
    if (capacity === undefined) return "normal";
    if (capacity >= RELAXED_AGING_MIN_CAPACITY) return "relaxed";
    if (capacity >= NORMAL_AGING_MIN_CAPACITY) return "normal";
    return "tight";
}

export interface ToolResultAgingPolicy {
    readonly capacity?: number;
    readonly overheadTokens?: number;
    readonly level?: ToolResultAgingLevel;
    readonly spillDirectory?: string;
    readonly ageAfterTurns?: number;
    readonly pendingUserTurns?: number;
    readonly budgetBytes?: number;
}

export interface ToolResultHistoryEntry {
    readonly message: ModelMessage;
}

export function assembleAgedToolResults(
    entries: readonly ToolResultHistoryEntry[],
    policy: ToolResultAgingPolicy = {},
): readonly ModelMessage[] {
    const level = TOOL_RESULT_AGING_LEVELS[
        policy.level ?? toolResultAgingLevel(policy.capacity)
    ];
    const ageAfterTurns = policy.ageAfterTurns ?? level.ageAfterTurns;
    const budgetBytes = policy.budgetBytes ?? TOOL_RESULT_TOTAL_BUDGET_BYTES;
    const gateTokens = (policy.capacity ?? UNKNOWN_CAPACITY_TOKENS)
        * level.gateFraction;

    const turnsAt = new Map<number, number>();
    const calls = new Map<string, ToolCallContent>();
    let turn = -1;

    for (let index = 0; index < entries.length; index += 1) {
        const message = entries[index]?.message;
        if (message === undefined) continue;
        if (message.role === "user" && message.internal !== true) {
            turn += 1;
        }
        turnsAt.set(index, turn);
        if (message.role === "assistant") {
            for (const content of message.content) {
                if (content.type === "tool_call") {
                    calls.set(content.id, content);
                }
            }
        }
    }
    turn += Math.max(0, policy.pendingUserTurns ?? 0);

    const projected: ModelMessage[] = entries.map((entry) => entry.message);
    let tokens = measureMessages(projected) + (policy.overheadTokens ?? 0);

    const candidates: number[] = [];
    const readCandidates: number[] = [];
    for (let index = 0; index < projected.length; index += 1) {
        const message = projected[index];
        if (
            message?.role !== "tool_result"
            || message.toolResultSource?.spillPath === undefined
            || message.toolResultSource.originalBytes
                <= TOOL_RESULT_VERBATIM_FLOOR_BYTES
        ) {
            continue;
        }
        const age = turn - (turnsAt.get(index) ?? -1);
        if (age < ageAfterTurns) continue;
        const call = calls.get(message.toolCallId);
        if (readsSpill(call, policy.spillDirectory)) continue;
        if (message.toolName === "read") {
            if (level.ageReads) readCandidates.push(index);
            continue;
        }
        candidates.push(index);
    }

    for (const index of [...candidates, ...readCandidates]) {
        if (tokens < gateTokens) break;
        const message = projected[index];
        if (message?.role !== "tool_result") continue;
        const sourceText = readSpill(message.toolResultSource?.spillPath);
        if (sourceText === undefined) continue;
        const aged = agedToolResult(
            message,
            calls.get(message.toolCallId),
            laterAssistantText(entries, index),
            sourceText,
        );
        const saved = measureMessages([message]) - measureMessages([aged]);
        if (saved <= 0) continue;
        tokens -= saved;
        projected[index] = aged;
    }

    return Object.freeze(applyToolResultBudget(
        projected,
        entries,
        calls,
        budgetBytes,
    ));
}

function readsSpill(
    call: ToolCallContent | undefined,
    spillDirectory: string | undefined,
): boolean {
    if (call === undefined || spillDirectory === undefined) return false;
    if (call.name === "read") {
        return typeof call.input.path === "string"
            && call.input.path.startsWith(spillDirectory);
    }
    if (call.name === "bash") {
        return typeof call.input.command === "string"
            && call.input.command.includes(spillDirectory);
    }
    return false;
}

function applyToolResultBudget(
    projected: readonly ModelMessage[],
    entries: readonly ToolResultHistoryEntry[],
    calls: ReadonlyMap<string, ToolCallContent>,
    budgetBytes: number,
): readonly ModelMessage[] {
    const messages = [...projected];
    let carriedBytes = totalToolResultBytes(messages);
    if (carriedBytes <= budgetBytes) return messages;

    const eligible: number[] = [];
    const digestible: number[] = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (
            message?.role === "tool_result"
        ) {
            eligible.push(index);
            if (
                message.toolResultSource?.spillPath !== undefined
                && message.toolResultSource.originalBytes
                    > TOOL_RESULT_VERBATIM_FLOOR_BYTES
            ) {
                digestible.push(index);
            }
        }
    }

    for (const index of digestible) {
        if (carriedBytes <= budgetBytes) break;
        const message = messages[index];
        if (message?.role !== "tool_result") continue;
        const source = readSpill(message.toolResultSource?.spillPath);
        if (source === undefined) continue;
        carriedBytes = replaceWhenSmaller(
            messages,
            index,
            message,
            agedToolResult(
                message,
                calls.get(message.toolCallId),
                laterAssistantText(entries, index),
                source,
            ),
            carriedBytes,
        );
    }

    for (const index of eligible) {
        if (carriedBytes <= budgetBytes) break;
        const message = messages[index];
        if (message?.role !== "tool_result") continue;
        carriedBytes = replaceWhenSmaller(
            messages,
            index,
            message,
            stubbedToolResult(message),
            carriedBytes,
        );
    }
    return messages;
}

function replaceWhenSmaller(
    messages: ModelMessage[],
    index: number,
    current: ToolResultMessage,
    replacement: ToolResultMessage,
    carriedBytes: number,
): number {
    const currentBytes = toolResultBytes(current);
    const replacementBytes = toolResultBytes(replacement);
    if (replacementBytes >= currentBytes) return carriedBytes;
    messages[index] = replacement;
    return carriedBytes - currentBytes + replacementBytes;
}

function totalToolResultBytes(messages: readonly ModelMessage[]): number {
    return messages.reduce(
        (total, message) => total + (message.role === "tool_result"
            ? toolResultBytes(message)
            : 0),
        0,
    );
}

function toolResultBytes(message: ToolResultMessage): number {
    return message.content.reduce(
        (total, content) => total + Buffer.byteLength(content.text, "utf8"),
        0,
    );
}

function agedToolResult(
    result: ToolResultMessage,
    call: ToolCallContent | undefined,
    laterText: string,
    sourceText: string,
): ToolResultMessage {
    const sourcePath = result.toolResultSource?.spillPath;
    if (!isDigestableTool(result.toolName)) {
        return stubbedToolResult(result);
    }
    const references = extractReferences(laterText);
    const body = digestFor(result, call, sourceText);
    const retained = provenanceLines(sourceText, references);
    const provenance = retained.length === 0
        ? []
        : [
            "[vera] Provenance retained from later assistant messages:",
            ...retained.map((line) => `  ${line}`),
        ];
    const output = boundDigest([
        body,
        ...provenance,
        "[vera] Full output remains available at "
            + `${sourcePath}; re-read it if needed.`,
    ].join("\n"), result.toolResultSource?.originalBytes ?? 0);
    return {
        ...result,
        content: [{ type: "text", text: output }],
    };
}

function stubbedToolResult(result: ToolResultMessage): ToolResultMessage {
    return {
        ...result,
        content: [{ type: "text", text: stubFor(result) }],
    };
}

function isDigestableTool(tool: string): boolean {
    return tool === "grep"
        || tool === "bash"
        || tool === "read"
        || tool === "list";
}

function stubFor(result: ToolResultMessage): string {
    const sourcePath = result.toolResultSource?.spillPath;
    return [
        `[vera] Stub for older ${result.toolName} result: `
            + `${formatBytes(result.toolResultSource?.originalBytes ?? 0)}.`,
        sourcePath === undefined || readSpill(sourcePath) === undefined
            ? "[vera] The durable session retains the original result, but no "
                + "re-readable spill is available for this request."
            : "[vera] Full output remains available at "
                + `${sourcePath}; re-read it if needed.`,
    ].join("\n");
}

function digestFor(
    result: ToolResultMessage,
    call: ToolCallContent | undefined,
    source: string,
): string {
    const header = `[vera] Digest of older ${result.toolName} result: `
        + `${formatBytes(result.toolResultSource?.originalBytes ?? 0)}.`;
    switch (result.toolName) {
        case "grep":
            return `${header}\n${grepDigest(source, call)}`;
        case "bash":
            return `${header}\n${bashDigest(source, call, result.isError)}`;
        case "read":
            return `${header}\n${readDigest(source, call)}`;
        case "list":
            return `${header}\n${listDigest(source)}`;
        default:
            return `${header}\n[vera] This tool has no mechanical digest; `
                + "the result is represented by this pointer.";
    }
}

function grepDigest(source: string, call: ToolCallContent | undefined): string {
    const countMode = call?.input.output_mode === "count";
    const files = new Map<string, { count: number; lines: string[] }>();
    for (const raw of source.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (
            line.length === 0
            || line === "--"
            || line.startsWith("[")
            || line.startsWith("(")
        ) {
            continue;
        }
        const countMatch = countMode ? /^(.*?):(\d+)$/.exec(line) : null;
        if (countMatch !== null) {
            const path = countMatch[1]!;
            const row = files.get(path) ?? { count: 0, lines: [] };
            row.count += Number(countMatch[2]);
            files.set(path, row);
            continue;
        }
        const match = /^(.*?):(\d+)(?::|\t|$)/.exec(line);
        if (match !== null) {
            const path = match[1]!;
            const row = files.get(path) ?? { count: 0, lines: [] };
            row.count += 1;
            if (row.lines.length < 12) row.lines.push(match[2]!);
            files.set(path, row);
            continue;
        }
        const count = /^(.*?):(\d+)$/.exec(line);
        const path = count?.[1] ?? line;
        const row = files.get(path) ?? { count: 0, lines: [] };
        row.count += count === null ? 1 : Number(count[2]);
        files.set(path, row);
    }
    if (files.size === 0) return source.includes("no matches") ? "No matches." : "No file rollup available.";
    return [...files.entries()].slice(0, 64).map(([path, row]) => {
        const locations = row.lines.length === 0
            ? ""
            : ` (lines ${row.lines.join(", ")})`;
        return `- ${path}: ${row.count} match${row.count === 1 ? "" : "es"}${locations}`;
    }).join("\n");
}

function bashDigest(
    source: string,
    call: ToolCallContent | undefined,
    isError: boolean,
): string {
    const command = typeof call?.input.command === "string"
        ? call.input.command
        : "(command unavailable)";
    const tail = source.split(/\r?\n/).filter((line) => line.length > 0).slice(-12);
    return [
        `Command: ${command}`,
        `Exit: ${isError ? "non-zero" : "0"}`,
        "Tail:",
        ...(tail.length === 0 ? ["(no output)"] : tail.map((line) => `  ${line}`)),
    ].join("\n");
}

function readDigest(source: string, call: ToolCallContent | undefined): string {
    const path = typeof call?.input.path === "string"
        ? call.input.path
        : "(path unavailable)";
    const footer = /\[vera\] Showing lines ([^.]+)\./.exec(source)?.[1]
        ?? "range unavailable";
    const signatures = source.split(/\r?\n/)
        .filter((line) => /^\d+\t/.test(line))
        .slice(0, 8);
    return [
        `Path: ${path}`,
        `Range: ${footer}`,
        "Signature lines:",
        ...(signatures.length === 0
            ? ["(none)"]
            : signatures.map((line) => `  ${line}`)),
    ].join("\n");
}

function listDigest(source: string): string {
    const lines = source.split(/\r?\n/)
        .filter((line) => line.length > 0 && !line.startsWith("(") && !line.startsWith("["));
    const footer = /of (\d+)/.exec(source)?.[1];
    const count = footer ?? String(lines.length);
    return [
        `Entries: ${count}`,
        "First entries:",
        ...(lines.length === 0 ? ["(none)"] : lines.slice(0, 12).map((line) => `  ${line}`)),
    ].join("\n");
}

function laterAssistantText(
    entries: readonly ToolResultHistoryEntry[],
    resultIndex: number,
): string {
    return entries.slice(resultIndex + 1)
        .flatMap(({ message }) => message.role === "assistant"
            ? message.content.flatMap((content) =>
                content.type === "text" || content.type === "thinking"
                    ? [content.text]
                    : [])
            : [])
        .join("\n");
}

interface References {
    readonly locations: readonly { path: string; line: string }[];
    readonly fragments: readonly string[];
    readonly identifiers: readonly string[];
}

function extractReferences(text: string): References {
    const locations: { path: string; line: string }[] = [];
    for (const match of text.matchAll(/([\w.~\/-]+):(\d+)(?::\d+)?/g)) {
        locations.push({ path: match[1]!, line: match[2]! });
    }
    const fragments = new Set<string>();
    for (const match of text.matchAll(/["'`]([^"'`\n]{3,120})["'`]/g)) {
        fragments.add(match[1]!);
    }
    const identifiers = new Set<string>();
    const stopWords = new Set([
        "and", "are", "but", "for", "from", "has", "have", "into",
        "line", "that", "the", "this", "used", "was", "with",
    ]);
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
        if (!stopWords.has(match[0]!.toLowerCase())) {
            identifiers.add(match[0]!);
        }
    }
    return {
        locations,
        fragments: [...fragments],
        identifiers: [...identifiers],
    };
}

function provenanceLines(source: string, references: References): readonly string[] {
    if (
        references.locations.length === 0
        && references.fragments.length === 0
        && references.identifiers.length === 0
    ) {
        return [];
    }
    const retained: string[] = [];
    for (const line of source.split(/\r?\n/)) {
        if (
            references.fragments.some((fragment) => line.includes(fragment))
            || references.identifiers.some((identifier) => line.includes(identifier))
            || references.locations.some((location) =>
                line.includes(`${location.path}:${location.line}`)
                || line.startsWith(`${location.line}\t`)
            )
        ) {
            retained.push(line);
            if (retained.length === 32) break;
        }
    }
    return retained;
}

function readSpill(path: string | undefined): string | undefined {
    if (path === undefined) return undefined;
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
}

function boundDigest(text: string, originalBytes: number): string {
    const ceiling = Math.min(originalBytes, TOOL_RESULT_CEILING_BYTES);
    if (Buffer.byteLength(text, "utf8") <= ceiling) return text;
    const marker = `\n[vera] Digest clipped to ${ceiling} bytes.\n`;
    const markerBytes = Buffer.byteLength(marker, "utf8");
    if (markerBytes >= ceiling) {
        return decode(Buffer.from(text, "utf8").subarray(0, ceiling));
    }
    const available = ceiling - markerBytes;
    const headBytes = Math.ceil(available / 2);
    const bytes = Buffer.from(text, "utf8");
    return decode(bytes.subarray(0, headBytes))
        + marker
        + decode(bytes.subarray(bytes.length - (available - headBytes)));
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8")
        .decode(bytes)
        .replace(/^�+/, "")
        .replace(/�+$/, "");
}

function formatBytes(bytes: number): string {
    return `${bytes.toLocaleString()} bytes`;
}
