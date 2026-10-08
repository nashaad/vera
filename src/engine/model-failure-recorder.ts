import type {
    CompactionFinishedEvent,
    EngineEvent,
    EngineEventSubscriber,
} from "./events.ts";
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

// Cancelled and busy are the user's or the loop's doing, not the summarizer's.
const RECORDED_COMPACTION_OUTCOMES: ReadonlySet<CompactionFinishedEvent["outcome"]> =
    new Set(["unavailable", "rejected", "no_boundary"]);

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
        if (event.type === "compaction_finished") {
            if (!RECORDED_COMPACTION_OUTCOMES.has(event.outcome)) return;
            options.ledger.record({
                at: now().toISOString(),
                provider: event.provider ?? "unknown",
                model: event.model ?? event.strategy,
                kind: "compaction_failed",
                detail: event.reason === undefined
                    ? event.outcome
                    : `${event.outcome}: ${event.reason}`,
                sessionId: options.sessionId,
            });
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
