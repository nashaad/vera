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
        sessionPath: "/home/user/.vera/sessions/agent-1.jsonl",
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

test("TUI diagnostics identifies the build, host, and extension paths", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "idle",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        build: {
            clientVersion: "source abc1234+dirty",
            clientEntrypoint: "/worktree/clients/tui/main.ts",
            hostEntrypoint: "/other/clients/host/main.ts",
            hostPid: 42,
            hostStartedAt: "2026-08-09T20:00:00.000Z",
        },
        extensions: [{
            path: "/worktree/examples/extensions/btw",
            enabled: true,
        }, {
            path: "/old/disabled-extension",
            enabled: false,
        }],
    });

    expect(text).toContain("client       source abc1234+dirty");
    expect(text).toContain("entrypoint   /worktree/clients/tui/main.ts");
    expect(text).toContain("host         PID 42 · started 2026-08-09T20:00:00.000Z");
    expect(text).toContain("host entry   /other/clients/host/main.ts");
    expect(text).toContain("enabled       /worktree/examples/extensions/btw");
    expect(text).toContain("disabled      /old/disabled-extension");
    expect(text).not.toContain("────");
});

test("TUI diagnostics does not claim inheritance without host data", () => {
    const text = renderTuiDiagnostics({
        state: {
            ...createTuiState(),
            modelSettings: {
                model: "parent-model",
                reasoningEffort: "max",
            },
        },
        activity: "thinking",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
    });

    expect(text).toContain(
        "subagents    unknown (restart the resident host)",
    );
    expect(text).not.toContain("inherit parent");
});

test("TUI diagnostics shows the effective fixed subagent default", () => {
    const text = renderTuiDiagnostics({
        state: {
            ...createTuiState(),
            modelSettings: {
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
                subagentDefault: {
                    mode: "fixed",
                    provider: "openrouter",
                    model: "openai/gpt-5.4-mini",
                    reasoningEffort: "low",
                },
            },
        },
        activity: "thinking",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
    });

    expect(text).toContain("model        gpt-5.6-sol");
    expect(text).toContain("reasoning    high");
    expect(text).toContain(
        "subagents    openrouter/openai/gpt-5.4-mini (low)",
    );
});

test("TUI diagnostics explains inherited subagent settings", () => {
    const text = renderTuiDiagnostics({
        state: {
            ...createTuiState(),
            modelSettings: {
                model: "parent-model",
                subagentDefault: { mode: "inherit" },
            },
        },
        activity: "thinking",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
    });

    expect(text).toContain(
        "subagents    inherit parent (parent-model, default)",
    );
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

test("TUI diagnostics reports the pre-image stash with recovery steps", () => {
    const entries = Array.from({ length: 17 }, (_, index) => ({
        path: `/vault/note-${index + 1}.md`,
        sessionId: `session-${index + 1}`,
        capturedAt: "2026-08-05T19:00:00.000Z",
        bytes: 1024,
    }));
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "thinking",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        stash: {
            sessions: 17,
            preimages: 17,
            bytes: 17 * 1024,
            oldestCapturedAt: "2026-08-05T19:00:00.000Z",
            entries,
        },
        stashRoot: "/home/user/.vera/stash",
        now: Date.parse("2026-08-05T20:00:00.000Z"),
    });

    expect(text).toContain(
        "stash        17 pre-images across 17 sessions (17.0 KiB, oldest 1h)",
    );
    expect(text).toContain(
        "1h ago  1.0 KiB  /vault/note-15.md  (/home/user/.vera/stash/session-15)",
    );
    expect(text).not.toContain("/vault/note-16.md");
    expect(text).toContain("+ 2 more in /home/user/.vera/stash");
    expect(text).toContain("cp <key> <path>");
});

test("TUI diagnostics reports an empty stash without recovery steps", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "thinking",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        stashRoot: "/home/user/.vera/stash",
    });

    expect(text).toContain("stash        empty");
    expect(text).toContain("filesystem   /home/user/.vera/stash");
    expect(text).not.toContain("cp <key> <path>");
});
