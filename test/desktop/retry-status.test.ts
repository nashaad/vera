import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LiveStatus } from "../../clients/ui/src/session/LiveStatus.tsx";
import { retryAfter } from "../../clients/ui/src/session/live.ts";
import type { RetryState } from "../../clients/ui/src/session/model.ts";
import type { LiveMessage } from "../../clients/ui/src/session/wire.ts";

const status = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(LiveStatus, {
        calls: [],
        streaming: false,
        tokens: 0,
        waiting: false,
        ...props,
    }));

function retry(at: number): RetryState {
    return {
        model: "gpt-6.1-terra",
        nextAttempt: 3,
        maxAttempts: 7,
        retryAt: at,
        failureKind: "connection",
    };
}

describe("desktop retry status line", () => {
    test("waiting names the model, the attempt, the wait, the failure and the clock", () => {
        const now = Date.now();
        const html = status({
            since: now - 724_000,
            retry: retry(now + 8_900),
        });
        expect(html).toContain("Retrying on gpt-6.1-terra");
        expect(html).toContain("attempt 3 of 7 in 8s · network error");
        expect(html).toContain("12m04s");
    });

    test("in flight names the model, the silence, the failure and the clock", () => {
        const now = Date.now();
        const html = status({
            since: now - 724_000,
            retry: retry(now - 80_000),
        });
        expect(html).toContain("Retrying on gpt-6.1-terra");
        expect(html).toContain("attempt 3 of 7 · no reply 1m20s · network error");
        expect(html).toContain("12m04s");
    });

    test("a server failure shows its status code", () => {
        const now = Date.now();
        const html = status({
            retry: { ...retry(now + 2_000), failureKind: "server", statusCode: 503 },
        });
        expect(html).toContain("503");
    });
});

describe("retryAfter", () => {
    const current = retry(Date.now() + 1_000);

    test("clears when the attempted model answers or works", () => {
        const messages: LiveMessage[] = [
            { type: "assistant_delta", text: "hello" },
            { type: "assistant_thinking", text: "hm" },
            { type: "assistant_thinking_progress", characters: 8 },
            { type: "tool_started", tool: "read", args: { path: "a.md" } },
            { type: "turn_finished", empty: false },
        ];
        for (const message of messages) {
            expect(retryAfter(current, message)).toBeUndefined();
        }
    });

    test("clears when the turn's model falls back", () => {
        expect(retryAfter(current, {
            type: "model_substitution",
            substitution: {
                model: "gpt-6.1-terra",
                requested: "gpt-6.1-terra",
                using: "gpt-6.1-terra-mini",
                reason: "overloaded",
                scope: "model",
            },
            source: "turn",
        })).toBeUndefined();
    });

    test("keeps the retry through an effort change, a subagent fallback and unrelated work", () => {
        expect(retryAfter(current, {
            type: "model_substitution",
            substitution: {
                model: "gpt-6.1-terra",
                requested: "high",
                using: "low",
                reason: "long reasoning",
                scope: "effort",
            },
            source: "turn",
        })).toBe(current);
        expect(retryAfter(current, {
            type: "model_substitution",
            substitution: {
                model: "gpt-6.1-terra",
                requested: "gpt-6.1-terra",
                using: "gpt-6.1-terra-mini",
                reason: "overloaded",
                scope: "model",
            },
            source: "subagent",
        })).toBe(current);
        expect(retryAfter(current, {
            type: "tool_finished",
            tool: "read",
            isError: false,
        })).toBe(current);
    });
});
