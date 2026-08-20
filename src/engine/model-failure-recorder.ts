import type { EngineEvent, EngineEventSubscriber } from "./events.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import {
    type ModelFailureLedger,
    modelFailureKind,
} from "../store/model-failures.ts";

export interface ModelFailureRecorderOptions {
    readonly ledger: ModelFailureLedger;
    readonly sessionId: string;
    readonly now?: () => Date;
}

/**
 * Records the failures a user actually sees: one per failed turn, not one per
 * retry underneath it. A stream error that the engine recovers from never
 * reaches a terminal turn, so it never reaches the ledger either.
 *
 * Vera's own synthesised failures (a review it interrupted, an attachment it
 * could not read) are not the model failing and are left out, because the
 * ledger's purpose is telling someone their model or provider is the problem.
 */
export function createModelFailureRecorder(
    options: ModelFailureRecorderOptions,
): EngineEventSubscriber {
    const now = options.now ?? (() => new Date());
    let pendingFailure: ProviderFailure | undefined;
    let pendingRequest: {
        readonly tokens: number;
        readonly estimated: boolean;
    } | undefined;

    return (event: EngineEvent): void => {
        if (event.type === "turn_started") {
            pendingFailure = undefined;
            pendingRequest = undefined;
            return;
        }
        if (event.type === "context_measured") {
            pendingRequest = {
                tokens: event.measurement.tokens,
                estimated: event.measurement.estimated,
            };
            return;
        }
        if (event.type === "model_stream_error") {
            pendingFailure = event.failure;
            return;
        }
        if (event.type !== "turn_finished") return;
        const message = event.message;
        const failure = pendingFailure;
        pendingFailure = undefined;
        const request = pendingRequest;
        pendingRequest = undefined;
        if (message.stopReason !== "error") return;
        if (message.source.provider === "vera") return;
        options.ledger.record({
            at: now().toISOString(),
            provider: message.source.provider,
            model: message.source.model,
            kind: modelFailureKind(message, failure),
            detail: message.errorMessage ?? "",
            sessionId: options.sessionId,
            ...(failure?.providerErrorType === undefined
                ? {}
                : { providerErrorType: failure.providerErrorType }),
            ...(failure?.providerName === undefined
                ? {}
                : { providerName: failure.providerName }),
            ...(failure?.statusCode === undefined
                ? {}
                : { statusCode: failure.statusCode }),
            ...(request === undefined
                ? {}
                : {
                    requestTokens: request.tokens,
                    requestTokensEstimated: request.estimated,
                }),
            ...(failure?.allowance === undefined
                ? {}
                : { allowance: failure.allowance }),
        });
    };
}
