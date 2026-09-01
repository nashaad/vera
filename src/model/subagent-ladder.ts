
import {
    EFFORT_LADDER,
    type EffortLevel,
    isEffortLevel,
    type RelativeEffort,
} from "./effort-ladder.ts";
import {
    formatModelSubstitution,
    type ModelSubstitution,
} from "./types.ts";

export type { RelativeEffort };

export function modelRef(provider: string, model: string): string {
    return provider === "" ? model : `${provider}/${model}`;
}

export interface LadderCandidate {
    readonly provider: string;
    readonly model: string;
    readonly family?: string;
    readonly available: boolean;
    readonly levels?: readonly string[];
    readonly defaultLevel?: string;
    readonly tools?: boolean;
}

export interface LadderPool {
    readonly models: readonly LadderCandidate[];
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    readonly failsafe?: readonly string[];
}

export interface SubagentModelRequest {
    readonly suggested?: string;
    readonly suggestedEffort?: string;
    readonly sessionProvider: string;
    readonly sessionModel: string;
    readonly sessionEffort?: string;
    readonly configuredDefault?: string;
    readonly configuredDefaultEffort?: string;
    readonly selfEffort?: RelativeEffort;
}

export type LadderRung =
    | "suggestion"
    | "sibling"
    | "default"
    | "assignment"
    | "self"
    | "pool";

export interface AssignedSubagentModel {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
}

export interface AssignedSubagentRequest {
    readonly requested?: string;
    readonly requestedEffort?: string;
    readonly preferred?: string;
    readonly preferredEffort?: string;
    readonly assigned: readonly AssignedSubagentModel[];
    readonly allowSelf: boolean;
    readonly sessionProvider: string;
    readonly sessionModel: string;
    readonly sessionEffort?: string;
    readonly selfEffort?: RelativeEffort;
}

export type Substitution = ModelSubstitution;

export interface SubagentModelChoice {
    readonly ok: true;
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
    readonly rung: LadderRung;
    readonly substitutions: readonly Substitution[];
    readonly notice?: string;
}

export interface SubagentModelFailure {
    readonly ok: false;
    readonly reason: "configuration_required" | "not_permitted" | "unavailable";
    readonly error: string;
    readonly substitutions: readonly Substitution[];
}

export type SubagentModelOutcome = SubagentModelChoice | SubagentModelFailure;

export function resolveAssignedSubagentModel(
    request: AssignedSubagentRequest,
    pool: LadderPool,
): SubagentModelOutcome {
    const assignedRefs = request.assigned.map((entry) =>
        modelRef(entry.provider, entry.model));
    const requestedRef = request.requested === undefined
        ? undefined
        : assignedRef(request.requested, request.assigned);
    const selfRef = modelRef(request.sessionProvider, request.sessionModel);
    if (
        request.requested !== undefined
        && requestedRef === undefined
        && !(request.allowSelf && request.requested === selfRef)
    ) {
        return {
            ok: false,
            reason: "not_permitted",
            error: `Model ${request.requested} is not permitted for subagents. `
                + "Choose a model from the subagents assignment.",
            substitutions: [],
        };
    }

    const preferredRef = request.preferred === undefined
        ? undefined
        : assignedRef(request.preferred, request.assigned);
    const firstRef = requestedRef ?? preferredRef;
    const attempts: Attempt[] = [];
    if (firstRef !== undefined) {
        const configured = request.assigned[assignedRefs.indexOf(firstRef)];
        attempts.push({
            rung: requestedRef === undefined ? "default" : "suggestion",
            ref: firstRef,
            effort: requestedRef === undefined
                ? request.preferredEffort ?? configured?.effort
                : request.requestedEffort ?? configured?.effort,
        });
    }
    for (const assigned of request.assigned) {
        const ref = modelRef(assigned.provider, assigned.model);
        if (ref === firstRef) continue;
        attempts.push({
            rung: "assignment",
            ref,
            ...(assigned.effort === undefined ? {} : { effort: assigned.effort }),
            ...(firstRef === undefined ? {} : {
                forRef: firstRef,
                because: "this is the next model in the subagents assignment",
            }),
        });
    }
    if (request.allowSelf && !assignedRefs.includes(selfRef)) {
        const self = findCandidate(selfRef, pool);
        const effort = resolveRelativeEffort(
            request.selfEffort ?? "equal",
            request.sessionEffort,
            self,
        );
        attempts.push({
            rung: "self",
            ref: selfRef,
            ...(effort === undefined ? {} : { effort }),
            ...(firstRef === undefined ? {} : {
                forRef: firstRef,
                because: "parent-model fallback is enabled",
            }),
        });
    }

    const rejections: string[] = [];
    for (const candidate of attempts) {
        const resolved = tryCandidate(candidate, pool, rejections);
        if (resolved === undefined) continue;
        const ranRef = modelRef(resolved.provider, resolved.model);
        const substitutions: Substitution[] = [];
        if (candidate.forRef !== undefined && candidate.because !== undefined) {
            substitutions.push({
                scope: "model",
                model: ranRef,
                requested: candidate.forRef,
                using: ranRef,
                reason: joinReason(
                    rejectionFor(candidate.forRef, rejections),
                    candidate.because,
                ),
            });
        }
        if (resolved.effortChanged) {
            substitutions.push({
                scope: "effort",
                model: ranRef,
                requested: candidate.effort ?? "",
                ...(resolved.effort === undefined
                    ? {}
                    : { using: resolved.effort }),
                reason: `${ranRef} does not offer that level`,
            });
        }
        return {
            ok: true,
            provider: resolved.provider,
            model: resolved.model,
            ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
            rung: candidate.rung,
            substitutions,
            ...(substitutions.length === 0
                ? {}
                : { notice: formatNotice(substitutions) }),
        };
    }
    return {
        ok: false,
        reason: attempts.length === 0
            ? "configuration_required"
            : "unavailable",
        error: attempts.length === 0
            ? "No subagent models are configured. Choose models in Defaults -> Subagents."
            : "No configured subagent model is available. Every candidate was rejected: "
                + rejections.join("; ") + ".",
        substitutions: [],
    };
}

function assignedRef(
    requested: string,
    assigned: readonly AssignedSubagentModel[],
): string | undefined {
    const exact = assigned.find((entry) =>
        modelRef(entry.provider, entry.model) === requested);
    if (exact !== undefined) return modelRef(exact.provider, exact.model);
    const bare = assigned.filter((entry) => entry.model === requested);
    return bare.length === 1
        ? modelRef(bare[0]!.provider, bare[0]!.model)
        : undefined;
}

interface Attempt {
    readonly rung: LadderRung;
    readonly ref: string;
    readonly effort?: string;
    readonly forRef?: string;
    readonly because?: string;
}

export function resolveSubagentModel(
    request: SubagentModelRequest,
    pool: LadderPool,
): SubagentModelOutcome {
    const rejections: string[] = [];
    const attempt = (candidate: Attempt): SubagentModelChoice | undefined => {
        const resolved = tryCandidate(candidate, pool, rejections);
        if (resolved === undefined) {
            return undefined;
        }
        const ranRef = modelRef(resolved.provider, resolved.model);
        const substitutions: Substitution[] = [];
        if (candidate.forRef !== undefined && candidate.because !== undefined) {
            substitutions.push({
                scope: "model",
                model: ranRef,
                requested: candidate.forRef,
                using: ranRef,
                reason: joinReason(
                    rejectionFor(candidate.forRef, rejections),
                    candidate.because,
                ),
            });
        }
        if (resolved.effortChanged) {
            substitutions.push({
                scope: "effort",
                model: ranRef,
                requested: candidate.effort ?? "",
                ...(resolved.effort === undefined
                    ? {}
                    : { using: resolved.effort }),
                reason: `${ranRef} does not offer that level`,
            });
        }
        return {
            ok: true,
            provider: resolved.provider,
            model: resolved.model,
            ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
            rung: candidate.rung,
            substitutions,
            ...(substitutions.length === 0
                ? {}
                : { notice: formatNotice(substitutions) }),
        };
    };

    for (const candidate of ladderAttempts(request, pool)) {
        const choice = attempt(candidate);
        if (choice !== undefined) {
            return choice;
        }
    }
    return {
        ok: false,
        reason: "unavailable",
        error:
            "No model could run this subagent. Every candidate was rejected: "
            + rejections.join("; ") + ".",
        substitutions: [],
    };
}

function* ladderAttempts(
    request: SubagentModelRequest,
    pool: LadderPool,
): Generator<Attempt> {
    const suggested = request.suggested;
    if (suggested !== undefined) {
        yield {
            rung: "suggestion",
            ref: suggested,
            ...(request.suggestedEffort === undefined
                ? {}
                : { effort: request.suggestedEffort }),
        };
        for (const sibling of familySiblings(suggested, pool)) {
            yield {
                rung: "sibling",
                ref: sibling,
                ...(request.suggestedEffort === undefined
                    ? {}
                    : { effort: request.suggestedEffort }),
                forRef: suggested,
                because: "this is its closest sibling in the same provider "
                    + "and family",
            };
        }
    }

    const configured = request.configuredDefault;
    if (configured !== undefined && configured !== "self") {
        yield {
            rung: "default",
            ref: configured,
            ...(request.configuredDefaultEffort === undefined
                ? {}
                : { effort: request.configuredDefaultEffort }),
            ...(suggested === undefined ? {} : {
                forRef: suggested,
                because: "this is the configured subagent default",
            }),
        };
    }

    const selfRef = modelRef(request.sessionProvider, request.sessionModel);
    const selfEntry = findCandidate(selfRef, pool);
    const selfEffort = resolveRelativeEffort(
        request.selfEffort ?? "equal",
        request.sessionEffort,
        selfEntry,
    );
    const priorRef = suggested ?? (configured === undefined || configured === "self"
        ? undefined
        : configured);
    yield {
        rung: "self",
        ref: selfRef,
        ...(selfEffort === undefined ? {} : { effort: selfEffort }),
        ...(priorRef === undefined ? {} : {
            forRef: priorRef,
            because: "this is the session model, which the subagent falls "
                + "back to when no requested or default model can run",
        }),
    };

    for (const failsafe of failsafeBySimilarity(selfRef, pool)) {
        yield {
            rung: "pool",
            ref: failsafe,
            ...(selfEffort === undefined ? {} : { effort: selfEffort }),
            forRef: priorRef ?? selfRef,
            because: "nothing else on this provider could run, and this is a "
                + "verified model from the user's pool",
        };
    }
}

interface ResolvedCandidate {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
    readonly effortChanged: boolean;
}

function tryCandidate(
    candidate: Attempt,
    pool: LadderPool,
    rejections: string[],
): ResolvedCandidate | undefined {
    if (isDenied(candidate.ref, pool)) {
        rejections.push(`${candidate.ref} is denied`);
        return undefined;
    }
    if (!isAllowed(candidate.ref, pool)) {
        rejections.push(`${candidate.ref} is not in the allow list`);
        return undefined;
    }
    const entry = findCandidate(candidate.ref, pool);
    if (entry === undefined) {
        rejections.push(`${candidate.ref} is not in the pool`);
        return undefined;
    }
    if (!entry.available) {
        rejections.push(`${candidate.ref} is not available right now`);
        return undefined;
    }
    if (candidate.rung === "pool" && entry.tools !== true) {
        rejections.push(
            `${candidate.ref} is not known to support tool calling`,
        );
        return undefined;
    }
    const effort = nearestEffort(candidate.effort, entry);
    return {
        provider: entry.provider,
        model: entry.model,
        ...(effort === undefined ? {} : { effort }),
        effortChanged: candidate.effort !== undefined
            && effort !== candidate.effort,
    };
}

function familySiblings(ref: string, pool: LadderPool): readonly string[] {
    const entry = findCandidate(ref, pool);
    if (entry === undefined || entry.family === undefined) {
        return [];
    }
    return pool.models
        .filter((candidate) =>
            candidate.provider === entry.provider
            && candidate.family === entry.family
            && candidate.model !== entry.model)
        .map((candidate) => modelRef(candidate.provider, candidate.model));
}

function failsafeBySimilarity(
    selfRef: string,
    pool: LadderPool,
): readonly string[] {
    const self = findCandidate(selfRef, pool);
    const failsafe = (pool.failsafe ?? []).filter((ref) => ref !== selfRef);
    const score = (ref: string): number => {
        const entry = findCandidate(ref, pool);
        if (entry === undefined || self === undefined) {
            return 0;
        }
        return (entry.provider === self.provider ? 2 : 0)
            + (entry.family !== undefined && entry.family === self.family
                ? 1
                : 0);
    };
    return [...failsafe]
        .map((ref, index) => ({ ref, index, score: score(ref) }))
        .sort((left, right) =>
            right.score - left.score || left.index - right.index)
        .map((ranked) => ranked.ref);
}

function findCandidate(
    ref: string,
    pool: LadderPool,
): LadderCandidate | undefined {
    const exact = pool.models.find((candidate) =>
        modelRef(candidate.provider, candidate.model) === ref);
    if (exact !== undefined) {
        return exact;
    }
    const bare = pool.models.filter((candidate) => candidate.model === ref);
    return bare.length === 1 ? bare[0] : undefined;
}

function isDenied(ref: string, pool: LadderPool): boolean {
    return (pool.deny ?? []).some((pattern) => matchesPattern(ref, pattern));
}

function isAllowed(ref: string, pool: LadderPool): boolean {
    const allow = pool.allow ?? [];
    return allow.length === 0
        || allow.some((pattern) => matchesPattern(ref, pattern));
}

function matchesPattern(ref: string, pattern: string): boolean {
    const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${escaped}$`).test(ref);
}

function nearestEffort(
    asked: string | undefined,
    entry: LadderCandidate,
): string | undefined {
    const levels = entry.levels;
    if (levels === undefined) {
        return asked ?? entry.defaultLevel;
    }
    if (levels.length === 0) {
        return undefined;
    }
    if (asked === undefined) {
        return entry.defaultLevel ?? undefined;
    }
    if (levels.includes(asked)) {
        return asked;
    }
    const askedIndex = EFFORT_LADDER.indexOf(asked as EffortLevel);
    const measurable = levels.filter(isEffortLevel);
    if (askedIndex === -1 || measurable.length === 0) {
        return entry.defaultLevel ?? levels[levels.length - 1];
    }
    let best = measurable[0] as EffortLevel;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const level of measurable) {
        const index = EFFORT_LADDER.indexOf(level);
        const distance = Math.abs(index - askedIndex);
        const closer = distance < bestDistance;
        const tieGoesDown = distance === bestDistance
            && index < EFFORT_LADDER.indexOf(best);
        if (closer || tieGoesDown) {
            best = level;
            bestDistance = distance;
        }
    }
    return best;
}

function resolveRelativeEffort(
    relative: RelativeEffort,
    sessionEffort: string | undefined,
    entry: LadderCandidate | undefined,
): string | undefined {
    if (relative === "equal") {
        return sessionEffort;
    }
    if (relative === "lowest") {
        const levels = entry?.levels;
        if (levels === undefined || levels.length === 0) {
            return undefined;
        }
        return levels[levels.length - 1];
    }
    return relative;
}

function rejectionFor(
    ref: string,
    rejections: readonly string[],
): string | undefined {
    return rejections.find((line) => line.startsWith(`${ref} `));
}

function joinReason(
    rejection: string | undefined,
    because: string,
): string {
    return rejection === undefined ? because : `${rejection}, and ${because}`;
}

export function formatNotice(
    substitutions: readonly Substitution[],
): string {
    return substitutions.map(formatModelSubstitution).join(" ");
}
