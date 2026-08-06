import type { ProviderFailure } from "./provider-failure.ts";

/** The request parameter a provider refused. */
export type CapabilityParameter = "reasoning_effort" | "thinking" | "tools";

export interface CapabilityRejection {
    readonly parameter: CapabilityParameter;
    /** The provider's own wording, kept for the learned record. */
    readonly message: string;
}

/**
 * Failure kinds that can never be a capability rejection. A retry of the same
 * request would fix these, so treating one as evidence about the model would
 * record a fact that is not true.
 */
const NON_CAPABILITY_KINDS: ReadonlySet<ProviderFailure["kind"]> = new Set([
    "connection",
    "timeout",
    "rate_limit",
    "server",
    "authentication",
    "payment_required",
    "permission",
    "request_too_large",
]);

/**
 * Status codes a capability rejection arrives on. 400 and 422 are the usual
 * ones. 404 is included only for the tool-support case, where OpenRouter
 * answers "no endpoints found that support tool use" rather than a 400; the
 * text match below is what keeps a plain missing-model 404 out.
 */
const CAPABILITY_STATUS_CODES: ReadonlySet<number> = new Set([400, 404, 422]);

const REJECTION_PHRASE =
    /unsupported|not supported|does not support|doesn't support|no endpoints found|is not a valid|invalid value|invalid_value|unknown parameter|unrecognized|unrecognised/i;

interface ParameterPattern {
    readonly parameter: CapabilityParameter;
    readonly pattern: RegExp;
}

/**
 * Ordered because provider text often names more than one thing. Thinking is
 * checked before effort so an Ollama "does not support thinking" is recorded
 * against the capability the daemon actually named.
 */
const PARAMETER_PATTERNS: readonly ParameterPattern[] = [
    {
        parameter: "thinking",
        pattern: /\bthinking\b|enable_thinking|thinking_budget|["']?thinking["']?\s*:/i,
    },
    {
        parameter: "reasoning_effort",
        pattern: /reasoning[._\s-]?effort|reasoning\.effort|\beffort\b|reasoning_config/i,
    },
    {
        parameter: "tools",
        pattern: /\btools?\b|tool[_\s-]?use|tool[_\s-]?call|function[_\s-]?call/i,
    },
];

/**
 * Decides whether a provider failure is the provider refusing a capability
 * parameter, rather than a rate limit or a transport problem.
 *
 * Returning a rejection is what licences coarsening and a learned record, so
 * the test is deliberately narrow: a non-retryable failure, on a status code
 * providers use for parameter refusals, whose text both names a capability and
 * says it was refused. Anything else returns undefined and the request follows
 * the ordinary retry path.
 */
export function classifyCapabilityRejection(
    failure: ProviderFailure,
): CapabilityRejection | undefined {
    if (NON_CAPABILITY_KINDS.has(failure.kind)) {
        return undefined;
    }
    if (
        failure.statusCode !== undefined
        && !CAPABILITY_STATUS_CODES.has(failure.statusCode)
    ) {
        return undefined;
    }

    const text = [
        failure.message,
        failure.providerMessage,
        failure.providerCode,
        failure.providerErrorType,
    ].filter((part): part is string => part !== undefined).join(" | ");

    if (!REJECTION_PHRASE.test(text)) {
        return undefined;
    }

    const matched = PARAMETER_PATTERNS.find((entry) => entry.pattern.test(text));
    if (matched === undefined) {
        return undefined;
    }
    // A 404 that never names tool support is a missing model, not a refusal.
    if (failure.statusCode === 404 && matched.parameter !== "tools") {
        return undefined;
    }

    return {
        parameter: matched.parameter,
        message: failure.providerMessage ?? failure.message,
    };
}
