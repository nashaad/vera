import {
    classifyCapabilityRejection,
    type CapabilityRejection,
} from "../model/capability-rejection.ts";
import { coarsenOneStep } from "../model/effort-ladder.ts";
import {
    learnedFact,
    learnedSupportedFact,
    type EffortPool,
    type ModelRef,
} from "../model/effort-pool.ts";
import { effortLearnedKey, IMAGES_LEARNED_KEY } from "../model/pool-file.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import type { ModelInputMessage } from "../model/types.ts";

export interface EffortCoarseningOptions {
    readonly pool: EffortPool;
    readonly now?: () => Date;
}

export interface ModelEffortCoarsened {
    readonly model: string;
    readonly requested: string;
    readonly using: string;
    readonly reason: string;
}

export function coarsenAfterFailure(
    ref: ModelRef,
    requested: string | undefined,
    failure: ProviderFailure,
    alreadyTried: ReadonlySet<string>,
    options: EffortCoarseningOptions,
): ModelEffortCoarsened | undefined {
    const rejection = classifyCapabilityRejection(failure);
    if (rejection === undefined) {
        return undefined;
    }

    recordRejection(ref, requested, rejection, options);
    if (rejection.parameter !== "reasoning_effort" || requested === undefined) {
        return undefined;
    }

    const resolved = options.pool.resolveEffort(ref, requested);
    const next = coarsenOneStep(
        requested,
        resolved.efforts,
        new Set([...alreadyTried, requested]),
    );
    if (next === undefined) {
        return undefined;
    }

    const contradiction = resolved.providerEffort === undefined
        ? undefined
        : resolved.reason;
    return {
        model: ref.model,
        requested,
        using: next.level,
        reason: contradiction ?? rejection.message,
    };
}

function recordRejection(
    ref: ModelRef,
    requested: string | undefined,
    rejection: CapabilityRejection,
    options: EffortCoarseningOptions,
): void {
    let key: string;
    if (rejection.parameter === "reasoning_effort") {
        if (requested === undefined) {
            return;
        }
        key = effortLearnedKey(requested);
    } else {
        key = rejection.parameter;
    }
    options.pool.recordLearned(
        ref,
        key,
        learnedFact(rejection.message, options.now?.()),
    );
}

export interface EffortPreflight {
    readonly requested: string;
    readonly using?: string;
    readonly reason: string;
}

export function preflightEffort(
    pool: EffortPool,
    ref: ModelRef,
    requested: string,
): EffortPreflight | undefined {
    const resolved = pool.resolveEffort(ref, requested);
    if (resolved.providerEffort !== undefined) {
        return undefined;
    }
    if (resolved.efforts[requested] !== null) {
        return undefined;
    }
    const next = coarsenOneStep(requested, resolved.efforts);
    return {
        requested,
        ...(next === undefined ? {} : { using: next.level }),
        reason: resolved.reason
            ?? `the pool records effort "${requested}" as unsupported`
                + ` for this model`,
    };
}

export function recordAcceptedImage(
    pool: EffortPool,
    ref: ModelRef,
    messages: readonly ModelInputMessage[],
    now: Date = new Date(),
): void {
    if (pool.resolveImageSupport(ref) !== undefined) {
        return;
    }
    const carried = messages.some((message) =>
        message.role === "user"
        && message.content.some((block) => block.type === "image")
    );
    if (!carried) {
        return;
    }
    pool.recordLearned(ref, IMAGES_LEARNED_KEY, learnedSupportedFact(now));
}
