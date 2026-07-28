import type { ModelMessage, ModelTool, ModelUsage } from "../model/types.ts";
import type { ProjectedModelRequest } from "./model-request.ts";

/**
 * How much of the model's context window the next request occupies.
 *
 * Measured from the projected request rather than read off the last response.
 * A response reports the size of the request before it, so by the time one
 * arrives the transcript has already grown by that response, its tool results,
 * any deliveries that landed while it ran, and the prompt the user just typed.
 * Through a long tool loop that gap is the whole of what the number was being
 * watched for.
 */
export interface ContextMeasurement {
    readonly tokens: number;
    /** Absent for a model whose window Vera has no entry for. */
    readonly capacity?: number;
    /**
     * True while `tokens` comes from counting characters. Vera ships no
     * tokenizer, so a measurement taken before a request is always an
     * estimate; the provider's own count replaces it as soon as a response
     * reports one.
     */
    readonly estimated: boolean;
}

/**
 * Characters per token. Coarse on purpose: it is close enough across the
 * languages and code a session carries to size a bar and to decide there is
 * headroom, and it is why the result travels labelled as an estimate.
 */
const CHARACTERS_PER_TOKEN = 4;

/**
 * What the wire framing around each message costs beyond its text. Small, but
 * a long tool loop is hundreds of short messages, and ignoring it biases the
 * estimate low exactly where the window is tightest.
 */
const TOKENS_PER_MESSAGE = 4;

export function measureProjectedRequest(
    request: ProjectedModelRequest,
    capacity?: number,
): ContextMeasurement {
    let characters = request.systemPrompt.length;
    for (const tool of request.tools) {
        characters += measureTool(tool);
    }
    for (const message of request.messages) {
        characters += measureMessage(message);
    }
    return {
        tokens: Math.ceil(characters / CHARACTERS_PER_TOKEN)
            + request.messages.length * TOKENS_PER_MESSAGE,
        ...(capacity === undefined ? {} : { capacity }),
        estimated: true,
    };
}

/**
 * The provider's own count for the request it just answered, which supersedes
 * the estimate for that same request.
 */
export function measureReportedUsage(
    usage: ModelUsage,
    capacity?: number,
): ContextMeasurement | undefined {
    if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens <= 0) {
        return undefined;
    }
    return {
        tokens: usage.inputTokens,
        ...(capacity === undefined ? {} : { capacity }),
        estimated: false,
    };
}

export function isContextMeasurement(
    value: unknown,
): value is ContextMeasurement {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const measurement = value as Record<string, unknown>;
    return Number.isSafeInteger(measurement.tokens)
        && (measurement.tokens as number) >= 0
        && (measurement.capacity === undefined
            || (Number.isSafeInteger(measurement.capacity)
                && (measurement.capacity as number) > 0))
        && typeof measurement.estimated === "boolean";
}

function measureTool(tool: ModelTool): number {
    return tool.name.length
        + tool.description.length
        + JSON.stringify(tool.inputSchema).length;
}

/**
 * Image attachments are not counted. The projection holds their ids, not their
 * bytes, and no honest number can be derived from an id, so a turn carrying
 * images reads low until the provider reports the real count.
 */
function measureMessage(message: ModelMessage): number {
    if (message.role === "tool_result") {
        return message.toolName.length
            + sum(message.content, (block) => block.text.length);
    }
    if (message.role === "user") {
        return sum(
            message.content,
            (block) => block.type === "text" ? block.text.length : 0,
        );
    }
    return sum(message.content, (block) => {
        if (block.type === "text" || block.type === "thinking") {
            return block.text.length;
        }
        return block.name.length + JSON.stringify(block.input).length;
    });
}

function sum<T>(items: readonly T[], size: (item: T) => number): number {
    return items.reduce((total, item) => total + size(item), 0);
}
