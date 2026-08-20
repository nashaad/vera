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

    test("names a shrinking prompt allowance as a credit failure", () => {
        const body = JSON.stringify({
            error: {
                message: "Prompt tokens limit exceeded: 158544 > 91805. To increase, adjust the key's daily limit.",
            },
        });
        const failure = classifyOpenRouterError(httpError(402, body));

        expect(failure).toMatchObject({
            kind: "payment_required",
            resolution: "user_action",
            allowance: {
                kind: "prompt_tokens",
                requested: 158_544,
                available: 91_805,
            },
        });
        expect(failure.message).toContain("credit or key allowance");
        expect(failure.message).toContain("Add OpenRouter credits");
        expect(failure.message).not.toContain("Prompt tokens limit exceeded");
    });

    test("parses the envelope allowance before generic upstream diagnostics", () => {
        const body = JSON.stringify({
            error: {
                message: "Prompt tokens limit exceeded: 158544 > 91805",
                metadata: {
                    raw: JSON.stringify({ error: { message: "insufficient balance" } }),
                },
            },
        });
        expect(classifyOpenRouterError(httpError(402, body)).allowance).toEqual({
            kind: "prompt_tokens",
            requested: 158_544,
            available: 91_805,
        });
    });

    test("authoritative rate-limit metadata beats fuzzy key-limit wording", () => {
        expect(classifyOpenRouterStreamError({
            code: 429,
            message: "API key's limit for requests per minute exceeded",
            metadata: { errorType: "rate_limit_exceeded" },
        })).toMatchObject({
            kind: "rate_limit",
            resolution: "retry",
        });
    });

    test("typed token-limit metadata retains a reported credit allowance", () => {
        expect(classifyOpenRouterStreamError({
            code: 400,
            message: "Prompt tokens limit exceeded: 158544 > 91805",
            metadata: { errorType: "token_limit_exceeded" },
        })).toMatchObject({
            kind: "payment_required",
            allowance: { available: 91_805 },
        });
    });

    test("unsafe allowance numbers are not persisted", () => {
        const digits = "9".repeat(400);
        const failure = classifyOpenRouterStreamError({
            code: 402,
            message: `Prompt tokens limit exceeded: ${digits} > ${digits}`,
        });
        expect(failure.allowance).toBeUndefined();
    });

    test("records the output allowance when credit cannot fund max tokens", () => {
        const failure = classifyOpenRouterStreamError({
            code: 402,
            message: "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 27597.",
            metadata: { errorType: "token_limit_exceeded" },
        });

        expect(failure).toMatchObject({
            kind: "payment_required",
            allowance: {
                kind: "max_tokens",
                requested: 65_536,
                available: 27_597,
            },
        });
        expect(failure.userAction).toContain("switch provider or model");
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
