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
    /** The level that was asked for and refused. */
    readonly requested: string;
    /** The level the retry runs on. */
    readonly using: string;
    /** The provider's own wording for the refusal. */
    readonly reason: string;
}

/**
 * Turns a provider refusal into the next request's effort level.
 *
 * Returns undefined whenever the failure is not a refusal of the effort
 * parameter, or the resolved data offers no other level. Refusals of other
 * capabilities (tools, thinking, images) are still recorded, because the fact
 * is true and useful, but they are not something an effort step can rescue.
 *
 * `requested` is absent when the request named no effort. There is then
 * nothing to coarsen from, but the other capabilities are still refused on
 * such requests and their facts are still recorded.
 */
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

    // A level the pool still calls supported after recording this rejection is
    // one the user declared by hand. The pool's wording names that standoff;
    // the bare provider message would look like a first-time refusal.
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

/**
 * An effort learned key names the level that was refused. A request that
 * carried no level has none to name, so the refusal is dropped rather than
 * written against a level the model was never asked for. Every other
 * capability is about the model itself and is recorded either way.
 */
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

/**
 * What the pool says about a level before anything is sent.
 *
 * `using` absent means no level goes on the wire: the level is forbidden and
 * the model offers no neighbour to move to.
 */
export interface EffortPreflight {
    readonly requested: string;
    readonly using?: string;
    readonly reason: string;
}

/**
 * Consults the pool before the request instead of waiting for the provider to
 * refuse again.
 *
 * A level the resolved data calls supported is sent verbatim, which is the
 * whole point of the pool: no pre-flight fold table. Only a level the pool
 * positively forbids, by a hand-declared `null` or a learned rejection, is
 * moved, and it moves by the same one-step rule a live refusal uses. A level
 * nothing knows anything about is left exactly as asked.
 */
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

/**
 * A completed image request is evidence the model takes images. Outages are
 * not: those never reach here. Unknown stays unknown until a request that
 * actually carried an image succeeds. Declared and already-learned facts are
 * left alone; the user's word outranks a later observation.
 */
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
