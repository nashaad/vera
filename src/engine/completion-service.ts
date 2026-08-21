import type {
    ModelAdapter,
    ModelMessage,
    ModelReasoningEffort,
} from "../model/types.ts";

/**
 * One bounded model call, for code that needs an answer rather than a turn.
 *
 * This is the whole surface a strategy or an extension is given. It cannot
 * name a provider, reach an adapter, read credentials, register tools, stream,
 * or continue a conversation: Vera resolves the route, binds the models, and
 * hands back a function that turns messages into text. Everything a caller
 * would need in order to spend somebody else's key on something other than the
 * job it was bound for is on the other side of this boundary.
 */
export type CompleteText = (
    request: CompletionRequest,
    signal: AbortSignal,
) => Promise<CompletionResult>;

export interface CompletionRequest {
    readonly systemPrompt: string;
    readonly messages: readonly ModelMessage[];
    /** Clamped to `maxOutputTokens`; the binding decides the ceiling. */
    readonly maxTokens?: number;
}

export interface CompletionResult {
    readonly text: string;
    /** Which of the route's models answered. Diagnostic only. */
    readonly model: string;
    readonly provider?: string;
}

export interface CompletionModel {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface CompletionServiceSettings {
    readonly models: readonly CompletionModel[];
    readonly timeoutMs?: number;
    readonly maxOutputTokens?: number;
}

export const COMPLETION_TIMEOUT_MS = 120_000;
export const COMPLETION_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Failure is an exception rather than a union member because a caller has no
 * partial answer to work with: the one thing it asked for did not happen.
 */
export class CompletionUnavailableError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "CompletionUnavailableError";
    }
}

/**
 * Binds a resolved route. The models are tried in order and the first one that
 * answers wins, which is the same fallback shape `createRoutedToolReviewer`
 * uses: a route is a preference list, not a pool.
 */
export function createRoutedCompletionService(
    adapter: ModelAdapter,
    settings: CompletionServiceSettings,
): CompleteText {
    const timeoutMs = settings.timeoutMs ?? COMPLETION_TIMEOUT_MS;
    const ceiling = settings.maxOutputTokens ?? COMPLETION_MAX_OUTPUT_TOKENS;

    return async (request, signal) => {
        if (settings.models.length === 0) {
            throw new CompletionUnavailableError(
                "No model is configured for this route.",
            );
        }
        if (signal.aborted) {
            throw new CompletionUnavailableError("Cancelled.");
        }
        const maxTokens = Math.max(
            1,
            Math.min(request.maxTokens ?? ceiling, ceiling),
        );

        const reasons: string[] = [];
        for (const candidate of settings.models) {
            const timeout = AbortSignal.timeout(timeoutMs);
            const combined = AbortSignal.any([signal, timeout]);
            try {
                const stream = adapter.stream({
                    ...(candidate.provider === undefined
                        ? {}
                        : { provider: candidate.provider }),
                    model: candidate.model,
                    ...(candidate.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: candidate.reasoningEffort }),
                    maxTokens,
                    systemPrompt: request.systemPrompt,
                    messages: request.messages,
                    signal: combined,
                });
                const message = await stream.result();
                if (signal.aborted) {
                    throw new CompletionUnavailableError("Cancelled.");
                }
                if (message.stopReason !== "stop") {
                    // A truncated answer is not a cheaper answer. A summary cut
                    // at the token ceiling would be accepted as a projection and
                    // silently lose whatever came after the cut.
                    // The provider's own message when it left one: "stopped
                    // with error" alone names no cause to act on.
                    reasons.push(
                        `${candidate.model} stopped with ${message.stopReason}`
                        + (message.errorMessage === undefined
                            ? ""
                            : `: ${message.errorMessage}`),
                    );
                    continue;
                }
                const text = message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n")
                    .trim();
                if (text.length === 0) {
                    reasons.push(`${candidate.model} returned no text`);
                    continue;
                }
                return {
                    text,
                    model: candidate.model,
                    ...(candidate.provider === undefined
                        ? {}
                        : { provider: candidate.provider }),
                };
            } catch (error) {
                if (signal.aborted) {
                    throw new CompletionUnavailableError("Cancelled.");
                }
                if (error instanceof CompletionUnavailableError) {
                    throw error;
                }
                reasons.push(timeout.aborted
                    ? `${candidate.model} timed out`
                    : `${candidate.model} failed: ${errorSummary(error)}`);
            }
        }
        throw new CompletionUnavailableError(
            reasons.length === 0
                ? "The model route produced no answer."
                : `The model route produced no answer (${reasons.join("; ")}).`,
        );
    };
}

function errorSummary(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
