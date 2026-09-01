import type { ProviderFailure } from "./provider-failure.ts";

export type CapabilityParameter =
    | "reasoning_effort"
    | "thinking"
    | "tools"
    | "images";

export interface CapabilityRejection {
    readonly parameter: CapabilityParameter;
    readonly message: string;
}

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

const CAPABILITY_STATUS_CODES: ReadonlySet<number> = new Set([400, 404, 422]);

const REJECTION_PHRASE =
    /unsupported|not supported|does not support|doesn't support|no endpoints found|is not a valid|invalid value|invalid_value|unknown parameter|unrecognized|unrecognised/i;

interface ParameterPattern {
    readonly parameter: CapabilityParameter;
    readonly pattern: RegExp;
}

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
        parameter: "images",
        pattern:
            /\bimages?\b|image[_\s-]?url|image[_\s-]?input|\bvision\b|multimodal|input_modalities/i,
    },
    {
        parameter: "tools",
        pattern: /\btools?\b|tool[_\s-]?use|tool[_\s-]?call|function[_\s-]?call/i,
    },
];

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
    if (failure.statusCode === 404 && matched.parameter !== "tools") {
        return undefined;
    }

    return {
        parameter: matched.parameter,
        message: failure.providerMessage ?? failure.message,
    };
}
