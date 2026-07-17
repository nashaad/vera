import { describe, expect, test } from "bun:test";
import {
    ConnectionError,
    OpenRouterError,
    RequestTimeoutError,
} from "@openrouter/sdk/models/errors";

import { classifyOpenRouterError } from "../../src/providers/openrouter-error-classifier.ts";
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
});

function httpError(statusCode: number): OpenRouterError {
    return new OpenRouterError(`HTTP ${statusCode}`, {
        response: new Response(null, { status: statusCode }),
        request: new Request("https://openrouter.test/chat"),
        body: "",
    });
}
