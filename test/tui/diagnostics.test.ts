import { expect, test } from "bun:test";

import { renderTuiDiagnostics } from "../../clients/tui/diagnostics.ts";
import { createTuiState } from "../../clients/tui/state.ts";

test("TUI diagnostics explains a retrying model request", () => {
    const retryAt = "2026-07-29T17:00:02.000Z";
    const text = renderTuiDiagnostics({
        state: {
            ...createTuiState(),
            working: true,
            queuedPrompts: ["next"],
            context: { tokens: 2500, capacity: 10000, estimated: true },
            modelActivity: {
                type: "model_activity",
                phase: "retrying",
                model: "openai/gpt-5.6-sol",
                nextAttempt: 2,
                maxAttempts: 3,
                delayMs: 2000,
                retryAt,
                failure: {
                    kind: "server",
                    statusCode: 503,
                },
                seq: 9,
            },
        },
        activity: "retrying openai/gpt-5.6-sol",
        elapsed: "1m00s",
        sessionId: "agent-1",
        workspace: "/workspace",
        runningBackgroundAgents: 1,
        now: Date.parse("2026-07-29T17:00:00.000Z"),
    });

    expect(text).toContain("turn         retrying openai/gpt-5.6-sol");
    expect(text).toContain("request      retry 2 of 3");
    expect(text).toContain("last failure server (503)");
    expect(text).toContain("retry in     2s");
    expect(text).toContain("context      2500 / 10000 (25%) estimated");
    expect(text).toContain("queued       1");
});

test("TUI diagnostics remains useful before model activity arrives", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "thinking",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
    });

    expect(text).toContain("turn         idle");
    expect(text).toContain("context      unavailable");
    expect(text).toContain("session      unavailable");
});

test("TUI diagnostics describes the request after retry backoff ends", () => {
    const text = renderTuiDiagnostics({
        state: {
            ...createTuiState(),
            working: true,
            modelActivity: {
                type: "model_activity",
                phase: "retrying",
                model: "test",
                nextAttempt: 2,
                maxAttempts: 3,
                delayMs: 500,
                retryAt: "2026-07-29T17:00:00.500Z",
                failure: { kind: "timeout" },
                seq: 3,
            },
        },
        activity: "retrying test",
        elapsed: "2s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        now: Date.parse("2026-07-29T17:00:02.000Z"),
    });

    expect(text).toContain("request      attempt 2 of 3");
    expect(text).not.toContain("retry in");
});
