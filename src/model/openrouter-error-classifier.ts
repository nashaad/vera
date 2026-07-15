import {
    ConnectionError,
    OpenRouterError,
    RequestTimeoutError,
} from "@openrouter/sdk/models/errors";

import type { ProviderFailure } from "./provider-failure.ts";

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
        return { kind: "server", resolution: "retry", message, statusCode };
    }

    const mapping = HTTP_FAILURES[statusCode];
    if (mapping === undefined) {
        return { kind: "unknown", resolution: "none", message, statusCode };
    }
    return { ...mapping, message, statusCode };
}
