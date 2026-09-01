import type { ModelMessage, ModelUsage } from "../model/types.ts";
import { assertToolCallsPaired } from "../model/tool-pairing.ts";
import type { CompleteText } from "./completion-service.ts";
import { measureMessages } from "./context-measurement.ts";

export interface CompactionRequest {
    readonly messages: readonly ModelMessage[];
    readonly targetTokens: number;
    readonly models: Readonly<Record<string, CompleteText>>;
    readonly summaryWordCap?: number;
}

export interface CompactionProposal {
    readonly projection: readonly ModelMessage[];
    readonly model?: string;
    readonly provider?: string;
    readonly usage?: ModelUsage;
}

export type CompactionStrategy = (
    request: CompactionRequest,
    signal: AbortSignal,
) => Promise<CompactionProposal>;

export interface CompactionStrategyDefinition {
    readonly id: string;
    readonly models: readonly string[];
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
    for (const message of projection) {
        assertUsableMessage(message);
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

function assertUsableMessage(message: ModelMessage): void {
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
        if (block.type === "image_attachment") {
            throw new CompactionRejectedError(
                "A compacted context cannot carry an attachment reference.",
            );
        }
    }
}
