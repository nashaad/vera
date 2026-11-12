import type {
    ModelMessage,
    ModelUsage,
    TextContent,
    UserContent,
    UserMessage,
} from "../model/types.ts";
import { assertToolCallsPaired } from "../model/tool-pairing.ts";
import type { CompleteText } from "./completion-service.ts";
import { measureMessages } from "./context-measurement.ts";

export interface CompactionRequest {
    readonly messages: readonly ModelMessage[];
    readonly targetTokens: number;
    readonly models: Readonly<Record<string, CompleteText>>;
    readonly summaryWordCap?: number;
    // Leading messages of `messages` that repeat the previous projection rather than new history.
    readonly previousProjectionCount?: number;
}

export interface CompactionProposal {
    readonly projection: readonly ModelMessage[];
    readonly model?: string;
    readonly provider?: string;
    readonly usage?: ModelUsage;
    // Set only by strategies that drop messages rather than summarize them.
    readonly dropped?: CompactionDropCount;
}

export interface CompactionDropCount {
    readonly wholeTurns: number;
    // Assistant steps the projection omits from the turn it cuts into; zero when that turn is dropped whole.
    readonly cutTurnSteps: number;
}

export type CompactionStrategy = (
    request: CompactionRequest,
    signal: AbortSignal,
) => Promise<CompactionProposal>;

export interface CompactionStrategyDefinition {
    readonly id: string;
    readonly models: readonly string[];
    // The projection holds the prompt being worked on, so no carried copy is appended or reserved.
    readonly keepsPrompt?: boolean;
    readonly compact: CompactionStrategy;
}

export class CompactionRejectedError extends Error {
    readonly roomRelated: boolean;

    constructor(reason: string, roomRelated = false) {
        super(reason);
        this.name = "CompactionRejectedError";
        this.roomRelated = roomRelated;
    }
}

export function validateProposal(
    proposal: CompactionProposal,
    request: CompactionRequest,
): readonly ModelMessage[] {
    const projection = proposal.projection;
    if (!Array.isArray(projection) || projection.length === 0) {
        throw new CompactionRejectedError(
            "The compaction strategy returned no context.",
        );
    }
    const held = heldAttachmentIds(request.messages);
    for (const message of projection) {
        assertUsableMessage(message, held);
    }
    if (projection[0]?.role === "tool_result") {
        throw new CompactionRejectedError(
            "A compacted context cannot open with a tool result.",
        );
    }
    try {
        assertToolCallsPaired(projection, "The compacted context");
    } catch (error) {
        throw new CompactionRejectedError(
            error instanceof Error ? `${error.message}.` : String(error),
        );
    }
    const tokens = measureMessages(projection);
    if (tokens > request.targetTokens) {
        throw new CompactionRejectedError(
            `The compacted context is ${tokens} tokens, over the `
                + `${request.targetTokens} it had to fit.`,
            true,
        );
    }
    return projection;
}

function heldAttachmentIds(
    messages: readonly ModelMessage[],
): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "image_attachment") {
                ids.add(block.attachmentId);
            }
        }
    }
    return ids;
}

function assertUsableMessage(
    message: ModelMessage,
    held: ReadonlySet<string>,
): void {
    if (message === null || typeof message !== "object") {
        throw new CompactionRejectedError(
            "The compacted context contains something that is not a message.",
        );
    }
    if (
        message.role !== "user"
        && message.role !== "assistant"
        && message.role !== "tool_result"
    ) {
        throw new CompactionRejectedError(
            `The compacted context contains an unusable message role.`,
        );
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
        throw new CompactionRejectedError(
            "The compacted context contains a message with no content.",
        );
    }
    for (const block of message.content) {
        if (block.type === "image_attachment" && !held.has(block.attachmentId)) {
            throw new CompactionRejectedError(
                "A compacted context cannot carry an attachment reference the request does not hold.",
            );
        }
    }
}

// Keeps the words of a prompt; its attachment blocks are dropped.
export function promptWords(message: UserMessage): UserMessage | undefined {
    const content = message.content.filter((block) => block.type === "text");
    if (content.length === 0) {
        return undefined;
    }
    return {
        role: "user",
        content: structuredClone(content),
        ...(message.arrivedDuringTurn === true
            ? { arrivedDuringTurn: true }
            : {}),
    };
}

// Matches the words and the arrival flag; an internal message never counts.
export function projectionHoldsPrompt(
    projection: readonly ModelMessage[],
    prompt: UserMessage,
): boolean {
    const wanted = promptKey(prompt);
    return projection.some((message) =>
        message.role === "user"
        && message.internal !== true
        && promptKey(message) === wanted
    );
}

// Compares the words when there are any, and the whole content when there are none.
function promptKey(message: UserMessage): string {
    const words = message.content.filter(isTextBlock);
    return JSON.stringify({
        content: words.length > 0 ? words : message.content,
        arrived: message.arrivedDuringTurn === true,
    });
}

function isTextBlock(block: UserContent): block is TextContent {
    return block.type === "text";
}

export function startsTurn(message: ModelMessage): message is UserMessage {
    return message.role === "user"
        && message.internal !== true
        && message.arrivedDuringTurn !== true;
}

// The newest turn start, unless an assistant stop follows it: the prompt the strategy must keep.
export function workingPrompt(
    messages: readonly ModelMessage[],
): { readonly index: number; readonly message: UserMessage } | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined) {
            continue;
        }
        if (message.role === "assistant" && message.stopReason === "stop") {
            return undefined;
        }
        if (startsTurn(message)) {
            return { index, message };
        }
    }
    return undefined;
}
