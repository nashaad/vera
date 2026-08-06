import { describe, expect, test } from "bun:test";
import {
    ConnectionError,
    OpenRouterError,
    RequestTimeoutError,
} from "@openrouter/sdk/models/errors";

import {
    classifyOpenRouterError,
    classifyOpenRouterStreamError,
} from "../../src/providers/openrouter-error-classifier.ts";
import type {
    ProviderFailureKind,
    ProviderFailureResolution,
} from "../../src/model/provider-failure.ts";

interface HttpFailureCase {
    readonly statusCode: number;
    readonly kind: ProviderFailureKind;
    readonly resolution: ProviderFailureResolution;
}

describe("OpenRouter failure classification", () => {
    const httpCases: readonly HttpFailureCase[] = [
        { statusCode: 400, kind: "invalid_request", resolution: "user_action" },
        { statusCode: 401, kind: "authentication", resolution: "user_action" },
        { statusCode: 402, kind: "payment_required", resolution: "user_action" },
        { statusCode: 403, kind: "permission", resolution: "user_action" },
        { statusCode: 404, kind: "not_found", resolution: "user_action" },
        { statusCode: 408, kind: "timeout", resolution: "retry" },
        { statusCode: 413, kind: "request_too_large", resolution: "user_action" },
        { statusCode: 422, kind: "invalid_request", resolution: "user_action" },
        { statusCode: 429, kind: "rate_limit", resolution: "retry" },
        { statusCode: 500, kind: "server", resolution: "retry" },
        { statusCode: 529, kind: "server", resolution: "retry" },
    ];

    for (const item of httpCases) {
        test(`classifies HTTP ${item.statusCode} as ${item.kind}`, () => {
            expect(classifyOpenRouterError(httpError(item.statusCode))).toMatchObject(item);
        });
    }

    test("classifies SDK connection and timeout errors as retryable", () => {
        expect(classifyOpenRouterError(new ConnectionError("disconnected"))).toMatchObject({
            kind: "connection",
            resolution: "retry",
        });
        expect(classifyOpenRouterError(new RequestTimeoutError("timed out"))).toMatchObject({
            kind: "timeout",
            resolution: "retry",
        });
    });

    test("leaves unfamiliar errors unclassified", () => {
        expect(classifyOpenRouterError(new Error("unexpected"))).toEqual({
            kind: "unknown",
            resolution: "none",
            message: "unexpected",
        });
    });

    test("extracts allowlisted diagnostics without retaining the raw body", () => {
        const body = JSON.stringify({
            error: {
                message: "Provider returned error",
                metadata: {
                    provider_name: "Anthropic",
                    raw: JSON.stringify({
                        error: {
                            type: "invalid_request_error",
                            message: "invalid thinking block signature; authorization: Bearer secret-value; api_key=sk-example12345678; data:image/png;base64,AAAA",
                            authorization: "Bearer secret",
                            attachment: "base64-data",
                        },
                    }),
                },
            },
        });
        const failure = classifyOpenRouterError(httpError(400, body));

        expect(failure).toMatchObject({
            providerName: "Anthropic",
            providerCode: "invalid_request_error",
            providerMessage: expect.stringContaining(
                "invalid thinking block signature",
            ),
        });
        expect(failure).not.toHaveProperty("headers");
        expect(JSON.stringify(failure)).not.toContain("Bearer secret");
        expect(JSON.stringify(failure)).not.toContain("base64-data");
        expect(JSON.stringify(failure)).not.toContain("secret-value");
        expect(JSON.stringify(failure)).not.toContain("sk-example");
        expect(JSON.stringify(failure)).not.toContain("raw");
    });

    test("falls back to HTTP classification when stream metadata is absent", () => {
        expect(classifyOpenRouterStreamError({
            code: 429,
            message: "slow down",
        })).toMatchObject({
            kind: "rate_limit",
            resolution: "retry",
            statusCode: 429,
        });
        expect(classifyOpenRouterStreamError({
            code: 401,
            message: "bad key",
        })).toMatchObject({
            kind: "authentication",
            resolution: "user_action",
            statusCode: 401,
        });
    });
});

function httpError(statusCode: number, body = ""): OpenRouterError {
    return new OpenRouterError(`HTTP ${statusCode}`, {
        response: new Response(null, { status: statusCode }),
        request: new Request("https://openrouter.test/chat"),
        body,
    });
}
