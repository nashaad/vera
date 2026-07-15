import { describe, expect, test } from "bun:test";

import {
    ProviderFailureError,
    type ProviderFailure,
} from "../../src/model/provider-failure.ts";
import { retryBeforeStreamStart } from "../../src/model/retry.ts";

const retryableFailure: ProviderFailure = {
    kind: "connection",
    resolution: "retry",
    message: "temporary failure",
};

describe("provider retry", () => {
    test("retries a transient failure and returns the successful result", async () => {
        let attempts = 0;
        const delays: number[] = [];

        const result = await retryBeforeStreamStart(
            async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error("temporary failure");
                }
                return "complete";
            },
            {
                policy: { delaysMs: [500, 1000] },
                classifyFailure: () => retryableFailure,
                wait: async (delayMs) => {
                    delays.push(delayMs);
                },
            },
        );

        expect(result).toBe("complete");
        expect(attempts).toBe(2);
        expect(delays).toEqual([500]);
    });

    test("stops after exhausting the retry delays", async () => {
        let attempts = 0;
        const delays: number[] = [];

        const result = retryBeforeStreamStart(
            async () => {
                attempts += 1;
                throw new Error(`failure ${attempts}`);
            },
            {
                policy: { delaysMs: [500, 1000] },
                classifyFailure: () => retryableFailure,
                wait: async (delayMs) => {
                    delays.push(delayMs);
                },
            },
        );

        const error = await result.catch((value: unknown) => value);

        expect(error).toBeInstanceOf(ProviderFailureError);
        expect(error).toMatchObject({
            failure: retryableFailure,
            cause: new Error("failure 3"),
        });
        expect(attempts).toBe(3);
        expect(delays).toEqual([500, 1000]);
    });

    test("does not retry a non-retryable failure", async () => {
        let attempts = 0;
        const error = new Error("invalid request");

        const result = retryBeforeStreamStart(
            async () => {
                attempts += 1;
                throw error;
            },
            {
                policy: { delaysMs: [500, 1000] },
                classifyFailure: () => ({
                    kind: "invalid_request",
                    resolution: "user_action",
                    message: error.message,
                }),
                wait: async () => {
                    throw new Error("wait should not be called");
                },
            },
        );

        const failureError = await result.catch((value: unknown) => value);

        expect(failureError).toBeInstanceOf(ProviderFailureError);
        expect(failureError).toMatchObject({
            failure: {
                kind: "invalid_request",
                resolution: "user_action",
            },
            cause: error,
        });
        expect(attempts).toBe(1);
    });

    test("does not retry after the stream has started", async () => {
        let attempts = 0;
        const error = new Error("stream disconnected");

        const result = retryBeforeStreamStart(
            async (markStreamStarted) => {
                attempts += 1;
                markStreamStarted();
                throw error;
            },
            {
                policy: { delaysMs: [500, 1000] },
                classifyFailure: () => retryableFailure,
                wait: async () => {
                    throw new Error("wait should not be called");
                },
            },
        );

        const failureError = await result.catch((value: unknown) => value);

        expect(failureError).toBeInstanceOf(ProviderFailureError);
        expect(failureError).toMatchObject({
            failure: retryableFailure,
            cause: error,
        });
        expect(attempts).toBe(1);
    });

    test("aborts a pending backoff", async () => {
        const controller = new AbortController();
        const result = retryBeforeStreamStart(
            async () => {
                throw new Error("temporary failure");
            },
            {
                policy: { delaysMs: [500] },
                classifyFailure: () => retryableFailure,
                signal: controller.signal,
            },
        );

        setTimeout(() => controller.abort(new Error("stop now")), 0);

        await expect(result).rejects.toThrow("stop now");
    });
});
