import type { ModelMessage } from "../model/types.ts";

/**
 * Renders the turn so far for the automatic approval reviewer.
 *
 * Without this the reviewer has no way to tell an action the user asked for
 * from one the agent invented, so `user_authorization` is permanently
 * `unknown` and every high-risk action is denied.
 *
 * Tool results are stripped. Vera has no sandbox under the reviewer, so the
 * reviewer is the enforcement line, and tool output is the injectable part of
 * what it would read.
 */

/** Total budget for user and assistant messages. */
export const MAX_MESSAGE_TRANSCRIPT_TOKENS = 10_000;

/** Total budget for tool calls. Results are not rendered at all. */
export const MAX_TOOL_TRANSCRIPT_TOKENS = 10_000;

/** Per-entry cap for a user or assistant message. */
export const MAX_MESSAGE_ENTRY_TOKENS = 2_000;

/** Per-entry cap for one tool call. */
export const MAX_TOOL_ENTRY_TOKENS = 1_000;

/** How many of the most recent entries are considered at all. */
export const RECENT_ENTRY_LIMIT = 40;

interface TranscriptItem {
    readonly index: number;
    readonly role: string;
    readonly text: string;
    readonly kind: "message" | "tool";
}

export interface ReviewTranscript {
    readonly text: string;
    /**
     * One signature per entry in the whole turn. Hand it back as `seen` on the
     * next render to get only what is new.
     */
    readonly signatures: readonly string[];
    /**
     * The turn no longer extends what was rendered before, which means it was
     * rewound. A caller holding state about the old branch has to drop it: the
     * entries it was told about no longer exist.
     */
    readonly diverged: boolean;
}

/**
 * Renders whatever part of the turn the caller has not seen.
 *
 * Continuation is decided by matching signatures rather than by counting
 * entries. A count cannot tell a turn that grew from one that was rewound and
 * regrew, so a rewind past an authorization would leave the caller believing
 * it had already been shown an authorization the user discarded.
 *
 * Entries are numbered against the whole turn, so `[7]` means the same entry
 * whether it arrived in the first render or the fourth.
 */
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

    // Every user turn that fits the message budget is kept, and only then do
    // recent non-user entries compete for what is left. User turns are what
    // authorization is scored against, so letting tool calls crowd them out
    // would quietly push every high-risk action toward a denial.
    // Budgeted on the rendered line rather than the bare text. The
    // `[n] role: ` prefix is real context and over forty entries it is not a
    // rounding error.
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
    // The first turn is what the user asked for and the last is the most
    // recent thing they said, so they get the budget before the middle does.
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

/**
 * Identifies one entry well enough to tell a turn that grew from one that was
 * rewound. Content-derived, so an entry that was edited rather than removed
 * also reads as divergence.
 */
function signatureOf(item: TranscriptItem): string {
    // Role, exact length, and two independently seeded hashes. One 32-bit
    // hash would be enough for ordinary rewind detection, but transcript text
    // includes tool output, which is attacker-influenced, and a second hash
    // costs nothing.
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
                        text: JSON.stringify(block.input),
                        kind: "tool",
                    });
                }
            }
            continue;
        }
        // Neither tool results nor assistant prose are rendered. Tool results
        // carry outside text: file contents, command output, fetched pages.
        // Assistant prose is written by the model under review. Tool calls
        // stay, because they are the trajectory behind the proposed action.
    }
    return items;
}

function textOf(content: ModelMessage["content"]): string {
    return content
        .flatMap((block) => block.type === "text" ? [block.text] : [])
        .join("\n")
        .trim();
}

/** Bytes assumed per token. */
const APPROX_BYTES_PER_TOKEN = 4;

/**
 * Roughly four bytes per token. The budgets are coarse guardrails, so an
 * estimate is enough and avoids pulling a tokenizer into the engine.
 *
 * Measured in UTF-8 bytes, not UTF-16 code units, because the code-unit count
 * is wrong in the direction that matters: a transcript of CJK text is about
 * three bytes per unit, so counting units would let each entry carry roughly
 * three times its stated budget.
 */
export function approxTokens(text: string): number {
    return Math.ceil(utf8Length(text) / APPROX_BYTES_PER_TOKEN);
}

function utf8Length(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/**
 * Keeps the head and the tail, dropping the middle, and fits the marker inside
 * the cap rather than adding to it. Head-only truncation loses the end of a
 * tool result, which is usually where the outcome is, and the end of a long
 * user turn, which is often where the actual request lands.
 */
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
    // The marker is ASCII, so its code-unit length is also its byte length.
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

/**
 * The longest prefix fitting `prefixBytes` and the longest suffix fitting
 * `suffixBytes`, both cut between characters. Slicing at a raw byte or
 * code-unit offset can land inside a multi-byte character or between the
 * halves of a surrogate pair, which would put a replacement character into
 * the evidence the reviewer is judging.
 */
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
