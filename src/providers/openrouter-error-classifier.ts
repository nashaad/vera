import {
    ConnectionError,
    OpenRouterError,
    RequestTimeoutError,
} from "@openrouter/sdk/models/errors";
import type { ChatStreamChunkError } from "@openrouter/sdk/models";

import type { ProviderFailure } from "../model/provider-failure.ts";
import { sanitizeDiagnosticText } from "../model/diagnostic-text.ts";

interface HttpFailureMapping {
    readonly kind: ProviderFailure["kind"];
    readonly resolution: ProviderFailure["resolution"];
}

const HTTP_FAILURES: Readonly<Partial<Record<number, HttpFailureMapping>>> = {
    400: { kind: "invalid_request", resolution: "user_action" },
    401: { kind: "authentication", resolution: "user_action" },
    402: { kind: "payment_required", resolution: "user_action" },
    403: { kind: "permission", resolution: "user_action" },
    404: { kind: "not_found", resolution: "user_action" },
    408: { kind: "timeout", resolution: "retry" },
    413: { kind: "request_too_large", resolution: "user_action" },
    422: { kind: "invalid_request", resolution: "user_action" },
    429: { kind: "rate_limit", resolution: "retry" },
};

export function classifyOpenRouterError(value: unknown): ProviderFailure {
    const message = value instanceof Error ? value.message : String(value);

    if (value instanceof ConnectionError) {
        return { kind: "connection", resolution: "retry", message };
    }
    if (value instanceof RequestTimeoutError) {
        return { kind: "timeout", resolution: "retry", message };
    }
    if (!(value instanceof OpenRouterError)) {
        return { kind: "unknown", resolution: "none", message };
    }

    const statusCode = value.statusCode;
    if (statusCode >= 500) {
        return {
            kind: "server",
            resolution: "retry",
            message,
            statusCode,
            ...openRouterDiagnostics(value),
        };
    }

    const mapping = HTTP_FAILURES[statusCode];
    if (mapping === undefined) {
        return { kind: "unknown", resolution: "none", message, statusCode };
    }
    return { ...mapping, message, statusCode, ...openRouterDiagnostics(value) };
}

const STREAM_FAILURES: Readonly<Partial<Record<
    string,
    Omit<
        ProviderFailure,
        | "message"
        | "statusCode"
        | "providerErrorType"
        | "providerCode"
        | "providerName"
        | "providerMessage"
    >
>>> = {
    authentication: { kind: "authentication", resolution: "user_action" },
    permission_denied: { kind: "permission", resolution: "user_action" },
    payment_required: { kind: "payment_required", resolution: "user_action" },
    rate_limit_exceeded: { kind: "rate_limit", resolution: "retry" },
    provider_overloaded: { kind: "server", resolution: "retry" },
    provider_unavailable: { kind: "server", resolution: "retry" },
    server: { kind: "server", resolution: "retry" },
    timeout: { kind: "timeout", resolution: "retry" },
    not_found: { kind: "not_found", resolution: "user_action" },
    context_length_exceeded: {
        kind: "request_too_large",
        resolution: "user_action",
    },
    max_tokens_exceeded: {
        kind: "request_too_large",
        resolution: "user_action",
    },
    token_limit_exceeded: {
        kind: "request_too_large",
        resolution: "user_action",
    },
    payload_too_large: {
        kind: "request_too_large",
        resolution: "user_action",
    },
    string_too_long: {
        kind: "request_too_large",
        resolution: "user_action",
    },
    invalid_request: { kind: "invalid_request", resolution: "user_action" },
    invalid_prompt: { kind: "invalid_request", resolution: "user_action" },
    precondition_failed: {
        kind: "invalid_request",
        resolution: "user_action",
    },
    unprocessable: { kind: "invalid_request", resolution: "user_action" },
};

/** Classifies an error delivered inside an otherwise valid OpenRouter stream. */
export function classifyOpenRouterStreamError(
    error: ChatStreamChunkError,
): ProviderFailure {
    const providerErrorType = error.metadata?.errorType;
    const mapped = providerErrorType === undefined
        ? undefined
        : STREAM_FAILURES[providerErrorType];
    const codeMapping = error.code >= 500
        ? { kind: "server" as const, resolution: "retry" as const }
        : HTTP_FAILURES[error.code];
    const fallback = {
        kind: "unknown" as const,
        resolution: "none" as const,
    };
    return {
        ...(mapped ?? codeMapping ?? fallback),
        message: streamErrorMessage(error),
        statusCode: error.code,
        ...(providerErrorType === undefined ? {} : { providerErrorType }),
        ...(error.metadata?.providerCode === undefined
            ? {}
            : { providerCode: error.metadata.providerCode }),
    };
}

function streamErrorMessage(error: ChatStreamChunkError): string {
    const details = [
        error.metadata?.errorType,
        `code ${error.code}`,
        error.metadata?.providerCode === undefined
            ? undefined
            : `provider ${error.metadata.providerCode}`,
    ].filter((detail): detail is string => detail !== undefined);
    return `${error.message} (${details.join(", ")})`;
}

interface OpenRouterDiagnostics {
    readonly providerErrorType?: string;
    readonly providerCode?: string;
    readonly providerName?: string;
    readonly providerMessage?: string;
}

/**
 * OpenRouter may put an upstream provider error inside metadata.raw. Parse only
 * the diagnostic fields we understand; retaining the arbitrary body could log
 * echoed request content, credentials, or encoded attachments.
 */
function openRouterDiagnostics(error: OpenRouterError): OpenRouterDiagnostics {
    const body = parseRecord(error.body);
    const envelope = recordField(body, "error");
    const metadata = recordField(envelope, "metadata");
    const upstream = parseRecord(stringField(metadata, "raw"));
    const upstreamError = recordField(upstream, "error") ?? upstream;

    return compactDiagnostics({
        providerErrorType: stringField(metadata, "error_type"),
        providerCode: stringField(upstreamError, "type")
            ?? stringField(metadata, "provider_code"),
        providerName: stringField(metadata, "provider_name"),
        providerMessage: safeProviderMessage(
            stringField(upstreamError, "message")
                ?? nonGenericMessage(stringField(envelope, "message"), error.message),
        ),
    });
}

function parseRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function recordField(
    value: Readonly<Record<string, unknown>> | undefined,
    key: string,
): Readonly<Record<string, unknown>> | undefined {
    const field = value?.[key];
    return isRecord(field) ? field : undefined;
}

function stringField(
    value: Readonly<Record<string, unknown>> | undefined,
    key: string,
): string | undefined {
    const field = value?.[key];
    return typeof field === "string" && field.length > 0 ? field : undefined;
}

function nonGenericMessage(
    providerMessage: string | undefined,
    wrapperMessage: string,
): string | undefined {
    return providerMessage === undefined || providerMessage === wrapperMessage
        ? undefined
        : providerMessage;
}

function safeProviderMessage(value: string | undefined): string | undefined {
    return value === undefined ? undefined : sanitizeDiagnosticText(value);
}

function compactDiagnostics(value: OpenRouterDiagnostics): OpenRouterDiagnostics {
    return Object.fromEntries(
        Object.entries(value).filter((entry) => entry[1] !== undefined),
    );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
