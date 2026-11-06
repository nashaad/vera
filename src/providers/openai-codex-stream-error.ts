import { sanitizeDiagnosticText } from "../model/diagnostic-text.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import type { OpenAICodexStreamEvent } from "./openai-codex-wire.ts";

const RETRYABLE_SERVER_CODES: ReadonlySet<string> = new Set([
    "server_is_overloaded",
    "slow_down",
    "server_error",
]);

const RETRYABLE_SERVER_TYPES: ReadonlySet<string> = new Set([
    "service_unavailable_error",
    "server_error",
]);

const FALLBACK_MESSAGE = "OpenAI Codex stream failed";

// The backend sends overload as an `error` or `response.failed` event on a
// 200 response, so no HTTP status exists to classify.
export function classifyOpenAICodexStreamError(
    event: OpenAICodexStreamEvent,
): ProviderFailure {
    const response = objectValue(event.response);
    const error = objectValue(event.error ?? response.error);
    // A bare `error` event carries code and message at the top level.
    const bare: Record<string, unknown> = event.type === "error" ? event : {};
    const providerErrorType = nonEmptyString(error.type);
    const providerCode = nonEmptyString(error.code) ?? nonEmptyString(bare.code);
    const providerMessage = nonEmptyString(error.message)
        ?? nonEmptyString(response.message)
        ?? nonEmptyString(bare.message);

    const retryable = (
        providerCode !== undefined && RETRYABLE_SERVER_CODES.has(providerCode)
    ) || (
        providerErrorType !== undefined
        && RETRYABLE_SERVER_TYPES.has(providerErrorType)
    );

    return {
        kind: retryable ? "server" : "unknown",
        resolution: retryable ? "retry" : "none",
        message: providerMessage
            ?? (providerCode === undefined
                ? FALLBACK_MESSAGE
                : `${FALLBACK_MESSAGE} (${providerCode})`),
        ...(providerErrorType === undefined
            ? {}
            : { providerErrorType: sanitizeDiagnosticText(providerErrorType) }),
        ...(providerCode === undefined
            ? {}
            : { providerCode: sanitizeDiagnosticText(providerCode) }),
        ...(providerMessage === undefined
            ? {}
            : { providerMessage: sanitizeDiagnosticText(providerMessage) }),
    };
}

function objectValue(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : {};
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
}
