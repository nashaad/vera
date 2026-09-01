import { ProviderFailureError } from "../model/provider-failure.ts";
import { measureMessages } from "./context-measurement.ts";
import type {
    ModelAdapter,
    ModelMessage,
    ModelReasoningEffort,
    ModelUsage,
} from "../model/types.ts";

export type CompleteText = (
    request: CompletionRequest,
    signal: AbortSignal,
) => Promise<CompletionResult>;

export interface CompletionRequest {
    readonly systemPrompt: string;
    readonly messages: readonly ModelMessage[];
    readonly maxTokens?: number;
}

export interface CompletionResult {
    readonly text: string;
    readonly model: string;
    readonly provider?: string;
    readonly usage?: ModelUsage;
}

export interface CompletionModel {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly contextWindow?: number;
}

export interface CompletionServiceSettings {
    readonly models: readonly CompletionModel[];
    readonly timeoutMs?: number;
    readonly maxOutputTokens?: number;
}

export const COMPLETION_TIMEOUT_MS = 120_000;
export const COMPLETION_MAX_OUTPUT_TOKENS = 8_192;

export class CompletionUnavailableError extends Error {
    readonly roomRelated: boolean;

    constructor(reason: string, roomRelated = false) {
        super(reason);
        this.name = "CompletionUnavailableError";
        this.roomRelated = roomRelated;
    }
}

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
            skippedForWindow > 0 && skippedForWindow === settings.models.length,
        );
    };
}

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
        // An adapter that turns the deadline into an aborted message rather than a throw would otherwise be reported as the model's own stop reason, which names the symptom and hides.
        if (timeout.aborted) {
            return { kind: "failed", reason: `${candidate.model} timed out` };
        }
        if (message.stopReason !== "stop") {
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
                ...(message.usage === undefined ? {} : { usage: message.usage }),
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
