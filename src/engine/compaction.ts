import type { ModelMessage } from "../model/types.ts";
import { assertToolCallsPaired } from "../model/tool-pairing.ts";
import type { CompleteText } from "./completion-service.ts";
import { measureMessages } from "./context-measurement.ts";

/**
 * What a strategy is given, and all it is given.
 *
 * The engine owns when compaction happens, where the boundary falls, whether
 * the answer is acceptable, and the durable append. A strategy owns one
 * question: given this context, what shorter context stands for it. It holds
 * no session, no store, no provider, no adapter and no credentials, and the
 * messages it receives are a frozen copy, so it cannot reach past its answer
 * to change what happens next.
 */
export interface CompactionRequest {
    /** The span being compacted, oldest first. Frozen. */
    readonly messages: readonly ModelMessage[];
    /**
     * What the returned projection must fit under, in estimated tokens. A
     * proposal above this is rejected, so the strategy is told the number
     * rather than left to guess a length from the window.
     */
    readonly targetTokens: number;
    /** The models the strategy declared, bound by name to a resolved route. */
    readonly models: Readonly<Record<string, CompleteText>>;
}

export interface CompactionProposal {
    /**
     * The replacement context. Provider-neutral messages, not a summary
     * string: this is what a resumed session sends, long after whatever
     * produced it stopped being installed.
     */
    readonly projection: readonly ModelMessage[];
}

export type CompactionStrategy = (
    request: CompactionRequest,
    signal: AbortSignal,
) => Promise<CompactionProposal>;

export interface CompactionStrategyDefinition {
    /** `<publisher>/<local-id>`, matched against the configured strategy. */
    readonly id: string;
    /** Slot names config must map to routes. */
    readonly models: readonly string[];
    readonly compact: CompactionStrategy;
}

/**
 * A proposal the engine will not append. Separate from a provider failure or a
 * cancellation because it is the one outcome that says the strategy answered
 * and the answer was unusable, which is what a user needs told.
 */
export class CompactionRejectedError extends Error {
    /**
     * Whether a boundary with more room to summarize into could have produced
     * an accepted proposal. False for the structural faults, which a strategy
     * would reproduce exactly at any boundary, and retrying those only spends
     * calls to collect the same answer again.
     */
    readonly roomRelated: boolean;

    constructor(reason: string, roomRelated = false) {
        super(reason);
        this.name = "CompactionRejectedError";
        this.roomRelated = roomRelated;
    }
}

/**
 * Everything checked here is checked because a strategy is arbitrary code
 * whose output goes on to be sent to a provider verbatim, for the rest of the
 * session, including after a restart. The store validates the record's
 * relationship to the transcript; this validates the content itself, before
 * there is a record to write.
 */
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

/**
 * Rejected rather than dropped. A projection carrying a block Vera cannot
 * resolve later, an attachment reference chief among them, would fail at the
 * provider on some future turn, with nothing left to explain why.
 */
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
