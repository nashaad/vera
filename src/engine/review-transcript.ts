import type { ModelMessage } from "../model/types.ts";

export const MAX_MESSAGE_TRANSCRIPT_TOKENS = 10_000;

export const MAX_TOOL_TRANSCRIPT_TOKENS = 10_000;

export const MAX_MESSAGE_ENTRY_TOKENS = 2_000;

export const MAX_TOOL_ENTRY_TOKENS = 1_000;

export const RECENT_ENTRY_LIMIT = 40;

interface TranscriptItem {
    readonly index: number;
    readonly role: string;
    readonly text: string;
    readonly kind: "message" | "tool";
}

export interface ReviewTranscript {
    readonly text: string;
    readonly signatures: readonly string[];
    readonly diverged: boolean;
}

// A bash description is the model's own summary; the reviewer judges the command.
export function reviewedToolInput(
    tool: string,
    input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    if (tool !== "bash" || !("description" in input)) {
        return input;
    }
    const { description: _description, ...rest } = input;
    return rest;
}

export function renderReviewTranscript(
    messages: readonly ModelMessage[],
    seen: readonly string[] = [],
): ReviewTranscript {
    const all = collectItems(messages);
    const signatures = all.map(signatureOf);
    let shared = 0;
    while (
        shared < seen.length && shared < signatures.length
        && seen[shared] === signatures[shared]
    ) {
        shared += 1;
    }
    const diverged = shared < seen.length;
    const items = all.slice(shared);
    if (items.length === 0) {
        return { text: "", signatures, diverged };
    }

    const rendered = items.map((item) =>
        `[${item.index}] ${item.role}: ${
            truncateToTokens(
                item.text,
                item.kind === "message"
                    ? MAX_MESSAGE_ENTRY_TOKENS
                    : MAX_TOOL_ENTRY_TOKENS,
            )
        }`
    );
    const cost = rendered.map(approxTokens);
    const included = items.map(() => false);
    let messageTokens = 0;
    let toolTokens = 0;

    const userPositions = items.flatMap((item, position) =>
        item.role === "user" ? [position] : []
    );
    const takeUser = (position: number | undefined): void => {
        if (
            position === undefined || included[position]
            || messageTokens + cost[position]! > MAX_MESSAGE_TRANSCRIPT_TOKENS
        ) {
            return;
        }
        included[position] = true;
        messageTokens += cost[position]!;
    };
    takeUser(userPositions.at(0));
    takeUser(userPositions.at(-1));
    for (const position of [...userPositions].reverse()) {
        takeUser(position);
    }

    let recentEntries = 0;
    for (let position = items.length - 1; position >= 0; position -= 1) {
        const item = items[position]!;
        if (item.role === "user" || recentEntries >= RECENT_ENTRY_LIMIT) {
            continue;
        }
        const tokens = cost[position]!;
        if (item.kind === "tool") {
            if (toolTokens + tokens > MAX_TOOL_TRANSCRIPT_TOKENS) {
                continue;
            }
            toolTokens += tokens;
        } else {
            if (messageTokens + tokens > MAX_MESSAGE_TRANSCRIPT_TOKENS) {
                continue;
            }
            messageTokens += tokens;
        }
        included[position] = true;
        recentEntries += 1;
    }

    const lines = rendered.filter((_line, position) => included[position]);
    const dropped = items.length - lines.length;
    return {
        text: [
            ...(dropped > 0
                ? [`<omitted entries="${dropped}" reason="length" />`]
                : []),
            ...lines,
        ].join("\n"),
        signatures,
        diverged,
    };
}

function signatureOf(item: TranscriptItem): string {
    return `${item.role}:${item.text.length}`
        + `:${fnv1a(item.text, 0x811c9dc5)}`
        + `:${fnv1a(item.text, 0x9dc5811c)}`;
}

function fnv1a(text: string, seed: number): string {
    let hash = seed;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

function collectItems(
    messages: readonly ModelMessage[],
): readonly TranscriptItem[] {
    const items: TranscriptItem[] = [];
    for (const message of messages) {
        if (message.role === "user") {
            if (message.internal === true) continue;
            const text = textOf(message.content);
            if (text.length > 0) {
                items.push({
                    index: items.length + 1,
                    role: "user",
                    text,
                    kind: "message",
                });
            }
            continue;
        }
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "tool_call") {
                    items.push({
                        index: items.length + 1,
                        role: `tool_call ${block.name}`,
                        text: JSON.stringify(
                            reviewedToolInput(block.name, block.input),
                        ),
                        kind: "tool",
                    });
                }
            }
            continue;
        }
    }
    return items;
}

function textOf(content: ModelMessage["content"]): string {
    return content
        .flatMap((block) => block.type === "text" ? [block.text] : [])
        .join("\n")
        .trim();
}

const APPROX_BYTES_PER_TOKEN = 4;

export function approxTokens(text: string): number {
    return Math.ceil(utf8Length(text) / APPROX_BYTES_PER_TOKEN);
}

function utf8Length(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

function truncateToTokens(text: string, maxTokens: number): string {
    const maxBytes = Math.max(0, maxTokens) * APPROX_BYTES_PER_TOKEN;
    const total = utf8Length(text);
    if (total <= maxBytes) {
        return text;
    }
    const omitted = Math.ceil(
        (total - maxBytes) / APPROX_BYTES_PER_TOKEN,
    );
    const marker = `<truncated omitted_approx_tokens="${omitted}" />`;
    if (maxBytes <= marker.length) {
        return marker;
    }
    const available = maxBytes - marker.length;
    const prefixBytes = Math.floor(available / 2);
    const [prefix, suffix] = splitOnCharBoundaries(
        text,
        prefixBytes,
        available - prefixBytes,
    );
    return prefix + marker + suffix;
}

function splitOnCharBoundaries(
    text: string,
    prefixBytes: number,
    suffixBytes: number,
): readonly [string, string] {
    const suffixStartTarget = Math.max(0, utf8Length(text) - suffixBytes);
    let prefixEnd = 0;
    let suffixStart = text.length;
    let suffixStarted = false;
    let byteOffset = 0;
    let unitOffset = 0;
    for (const char of text) {
        const charEnd = byteOffset + utf8Length(char);
        if (charEnd <= prefixBytes) {
            prefixEnd = unitOffset + char.length;
        } else if (!suffixStarted && byteOffset >= suffixStartTarget) {
            suffixStart = unitOffset;
            suffixStarted = true;
        }
        byteOffset = charEnd;
        unitOffset += char.length;
    }
    return [
        text.slice(0, prefixEnd),
        text.slice(Math.max(suffixStart, prefixEnd)),
    ];
}
