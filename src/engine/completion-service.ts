import { ProviderFailureError } from "../model/provider-failure.ts";
import { measureMessages } from "./context-measurement.ts";
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
    /**
     * The window this model accepts, when Vera has an entry for it. A route
     * can mix sizes, and a request built for the session's window is not
     * automatically one a smaller model in the route can read.
     */
    readonly contextWindow?: number;
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
    /**
     * True when a smaller request would have had somewhere to go: a candidate
     * was passed over only because the request did not fit its window. The
     * compaction ladder reads this to decide whether a shorter span is worth
     * a second call.
     */
    readonly roomRelated: boolean;

    constructor(reason: string, roomRelated = false) {
        super(reason);
        this.name = "CompletionUnavailableError";
        this.roomRelated = roomRelated;
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
        let skippedForWindow = 0;
        const requestTokens = measureRequest(request);
        for (const candidate of settings.models) {
            // Sending a request the model cannot read costs a round trip to
            // be told so, in a provider's own words, at the moment the window
            // is already full. Skipping says which model and by how much.
            if (
                candidate.contextWindow !== undefined
                && requestTokens + maxTokens > candidate.contextWindow
            ) {
                skippedForWindow += 1;
                reasons.push(
                    `${candidate.model} skipped: the request is about `
                        + `${requestTokens} tokens by Vera's own estimate, `
                        + `which reads low against a real tokenizer, and its `
                        + `window is ${candidate.contextWindow}`,
                );
                continue;
            }
            const timeout = AbortSignal.timeout(timeoutMs);
            const combined = AbortSignal.any([signal, timeout]);
            let outcome = await attempt(
                adapter,
                candidate,
                request,
                maxTokens,
                signal,
                combined,
                timeout,
            );
            // A provider that names a smaller output allowance than the one
            // asked for gets one more call at that allowance. The ceiling
            // leaves room for reasoning; it is not a claim every model can
            // fill it.
            if (
                outcome.kind === "failed"
                && outcome.allowance !== undefined
                && outcome.allowance < maxTokens
            ) {
                outcome = await attempt(
                    adapter,
                    candidate,
                    request,
                    outcome.allowance,
                    signal,
                    combined,
                    timeout,
                );
            }
            if (outcome.kind === "answered") {
                return outcome.result;
            }
            reasons.push(outcome.reason);
        }
        throw new CompletionUnavailableError(
            reasons.length === 0
                ? "The model route produced no answer."
                : `The model route produced no answer (${reasons.join("; ")}).`,
            // Only when room is the whole story. A candidate that was tried
            // and failed for its own reasons will fail the same way on a
            // shorter span, and saying otherwise spends the ladder's calls
            // collecting one answer three times.
            skippedForWindow > 0 && skippedForWindow === settings.models.length,
        );
    };
}

/**
 * The request as the estimator sees it. Coarse on purpose: it decides whether
 * to spend a call, and the provider remains the authority on the answer.
 */
function measureRequest(request: CompletionRequest): number {
    return measureMessages(request.messages)
        + Math.ceil(request.systemPrompt.length / 4);
}

function errorSummary(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

type AttemptOutcome =
    | { readonly kind: "answered"; readonly result: CompletionResult }
    | {
        readonly kind: "failed";
        readonly reason: string;
        /** Output tokens the provider said it would accept, when it said. */
        readonly allowance?: number;
    };

async function attempt(
    adapter: ModelAdapter,
    candidate: CompletionModel,
    request: CompletionRequest,
    maxTokens: number,
    signal: AbortSignal,
    combined: AbortSignal,
    timeout: AbortSignal,
): Promise<AttemptOutcome> {
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
        // An adapter that turns the deadline into an aborted message rather
        // than a throw would otherwise be reported as the model's own stop
        // reason, which names the symptom and hides the cause.
        if (timeout.aborted) {
            return { kind: "failed", reason: `${candidate.model} timed out` };
        }
        if (message.stopReason !== "stop") {
            // A truncated answer is not a cheaper answer. A summary cut at
            // the token ceiling would be accepted as a projection and silently
            // lose whatever came after the cut. The provider's own message
            // when it left one: "stopped with error" alone names no cause.
            return {
                kind: "failed",
                reason: `${candidate.model} stopped with ${message.stopReason}`
                    + (message.errorMessage === undefined
                        ? ""
                        : `: ${message.errorMessage}`),
            };
        }
        const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .trim();
        if (text.length === 0) {
            return { kind: "failed", reason: `${candidate.model} returned no text` };
        }
        return {
            kind: "answered",
            result: {
                text,
                model: candidate.model,
                ...(candidate.provider === undefined
                    ? {}
                    : { provider: candidate.provider }),
            },
        };
    } catch (error) {
        if (signal.aborted) {
            throw new CompletionUnavailableError("Cancelled.");
        }
        if (error instanceof CompletionUnavailableError) {
            throw error;
        }
        if (timeout.aborted) {
            return { kind: "failed", reason: `${candidate.model} timed out` };
        }
        const allowance = error instanceof ProviderFailureError
            ? error.failure.allowance
            : undefined;
        return {
            kind: "failed",
            reason: `${candidate.model} failed: ${errorSummary(error)}`,
            ...(allowance?.kind === "max_tokens"
                    && Number.isSafeInteger(allowance.available)
                    && allowance.available > 0
                ? { allowance: allowance.available }
                : {}),
        };
    }
}
