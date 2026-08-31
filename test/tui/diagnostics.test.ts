import { expect, test } from "bun:test";

import { renderTuiDiagnostics } from "../../clients/tui/diagnostics.ts";
import { createTuiState } from "../../clients/tui/state.ts";
import { summariseModelFailures } from "../../src/store/model-failures.ts";

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

    expect(text).toContain("| Turn | retrying openai/gpt-5.6-sol |");
    expect(text).toContain("| Request | Retry 2 of 3 |");
    expect(text).toContain("| Last failure | server (503) |");
    expect(text).toContain("| Retry in | 2s |");
    expect(text).toContain("| Context | 2500 / 10000 (25%) estimated |");
    expect(text).toContain("| Queued | 1 |");
});

test("TUI diagnostics never presents missing prices as zero cost", () => {
    const text = renderTuiDiagnostics({
        state: {
            ...createTuiState(),
            sessionUsage: {
                rows: [{
                    provider: "deepseek",
                    model: "deepseek-v4-flash",
                    calls: 1,
                    durationMs: 2_690,
                    inputTokens: 22_474,
                    outputTokens: 18,
                    cachedInputTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 22_492,
                    callsWithoutCost: 1,
                }],
            },
        },
        activity: "idle",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
    });

    expect(text).toContain("cost unavailable · 1 unpriced");
    expect(text).not.toContain("$0.0000");
});

test("TUI diagnostics remains useful before model activity arrives", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "thinking",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
    });

    expect(text).toContain("| Turn | Idle |");
    expect(text).toContain("| Context | Unavailable |");
    expect(text).toContain("| ID | Unavailable |");
    expect(text).toContain("| File | Unavailable |");
    expect(text).not.toContain("MODEL FAILURES");
    expect(text).not.toContain("PRE-IMAGE STASH");
});

test("TUI session diagnostics prints the session ID and keeps Vera data out", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "idle",
        elapsed: "0s",
        sessionId: "session-123",
        sessionIdentity: "calm-wren:0001",
        sessionPath: "/home/user/.vera/sessions/session-123.jsonl",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        modelFailures: summariseModelFailures([]),
        stashRoot: "/home/user/.vera/stash",
    });

    expect(text).toContain("# Session diagnostics");
    expect(text).toContain("| ID | session-123 |");
    expect(text).toContain("| Identity | calm-wren:0001 |");
    expect(text).toContain(
        "| File | /home/user/.vera/sessions/session-123.jsonl |",
    );
    expect(text).not.toContain("## BUILD");
    expect(text).not.toContain("## EXTENSIONS");
    expect(text).not.toContain("## MODEL FAILURES");
    expect(text).not.toContain("## PRE-IMAGE STASH");
});

test("TUI session diagnostics shows the live process chain and memory", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "idle",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        processes: [
            { role: "client", pid: 101, rssBytes: 10 * 1024 * 1024 },
            { role: "host", pid: 102, rssBytes: 256 * 1024 * 1024 },
            { role: "worker", pid: 103, rssBytes: 1536 * 1024 * 1024 },
            { role: "supervisor", pid: 104 },
        ],
    });

    expect(text).toContain("## PROCESSES");
    expect(text).toContain("| client | 101 | 10.0 MiB |");
    expect(text).toContain("| host | 102 | 256.0 MiB |");
    expect(text).toContain("| worker | 103 | 1.50 GiB |");
    expect(text).toContain("| supervisor | 104 | Unavailable |");
});

test("TUI diagnostics shows marked startup timings near the top", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "idle",
        elapsed: "0s",
        scope: "vera",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        startup: {
            totalMs: 1_676,
            rows: [{
                label: "model_discovery",
                durationMs: 308,
                outcome: "completed",
            }, {
                label: "extension · vera.mcp",
                durationMs: 1_322,
                outcome: "loaded",
            }],
        },
    });

    expect(text.indexOf("BUILD")).toBeLessThan(text.indexOf("STARTUP"));
    expect(text).not.toContain("Runtime");
    expect(text).toContain("| total | 1.68s | ok |");
    expect(text).toContain("| model_discovery | 308ms | ok, slowest |");
    expect(text).toContain("| extension · vera.mcp | 1.32s | ok, slowest |");
});

test("TUI diagnostics puts itemized session usage above runtime", () => {
    const text = renderTuiDiagnostics({
        state: {
            ...createTuiState(),
            sessionUsage: {
                rows: [{
                    provider: "openrouter",
                    model: "deepseek/deepseek-v4",
                    calls: 2,
                    durationMs: 2_500,
                    inputTokens: 12_000,
                    outputTokens: 1_500,
                    cachedInputTokens: 8_000,
                    reasoningTokens: 400,
                    totalTokens: 13_500,
                    cost: 0.018,
                    callsWithoutCost: 1,
                }],
            },
        },
        activity: "idle",
        elapsed: "0s",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
    });

    expect(text.indexOf("SESSION USAGE")).toBeLessThan(text.indexOf("RUNTIME"));
    expect(text).toContain("| Runtime | 2.50s |");
    expect(text).toContain("### openrouter/deepseek/deepseek-v4");
    expect(text).toContain("| Input | 12,000 |");
    expect(text).toContain("| Cost | $0.02 reported · 1 unpriced |");
});

test("TUI diagnostics identifies the build, host, and extension paths", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "idle",
        elapsed: "0s",
        scope: "vera",
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
            path: "/worktree/examples/extensions/sample",
            enabled: true,
        }, {
            path: "/old/disabled-extension",
            enabled: false,
        }],
    });

    expect(text).toContain("| Client | source abc1234+dirty |");
    expect(text).toContain("| Client entrypoint | /worktree/clients/tui/main.ts |");
    expect(text).toContain("| Host | PID 42 · started 2026-08-09T20:00:00.000Z |");
    expect(text).toContain("| Host entrypoint | /other/clients/host/main.ts |");
    expect(text).toContain("| Enabled | /worktree/examples/extensions/sample |");
    expect(text).toContain("| Disabled | /old/disabled-extension |");
    expect(text).not.toContain("────");
});

test("TUI diagnostics reports the latest client extension reload", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "idle",
        elapsed: "0s",
        scope: "vera",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        clientExtensionReload: {
            status: "partial",
            loadedExtensionIds: ["sidebar", "search"],
            failures: ["broken: activation timed out"],
        },
    });

    expect(text).toContain("| Status | partial (2 loaded) |");
    expect(text).toContain("| Active | sidebar, search |");
    expect(text).toContain("| Error | broken: activation timed out |");
});

test("TUI diagnostics shows when client extensions have never reloaded", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "idle",
        elapsed: "0s",
        scope: "vera",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
    });

    expect(text).toContain("| Status | Never |");
});

test("TUI diagnostics does not present old extensions during a reload", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "idle",
        elapsed: "0s",
        scope: "vera",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        clientExtensionReload: {
            status: "reloading",
            loadedExtensionIds: [],
            failures: [],
        },
    });

    expect(text).toContain("| Status | Reloading |");
    expect(text).not.toContain("| Active |");
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
        "| Subagents | Unknown (restart the resident host) |",
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

    expect(text).toContain("| Model | gpt-5.6-sol |");
    expect(text).toContain("| Reasoning | high |");
    expect(text).toContain(
        "| Subagents | openrouter/openai/gpt-5.4-mini (low) |",
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
        "| Subagents | Inherit parent (parent-model, default) |",
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

    expect(text).toContain("| Request | Attempt 2 of 3 |");
    expect(text).not.toContain("| Retry in |");
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
        scope: "vera",
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
        "| Stash | 17 pre-images across 17 sessions (17.0 KiB, oldest 1h) |",
    );
    expect(text).toContain(
        "| 1h ago | 1.0 KiB | /vault/note-15.md | /home/user/.vera/stash/session-15 |",
    );
    expect(text).not.toContain("/vault/note-16.md");
    expect(text).toContain("> 2 more in /home/user/.vera/stash.");
    expect(text).toContain("cp <key> <path>");
});

test("TUI diagnostics reports an empty stash without recovery steps", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "thinking",
        elapsed: "0s",
        scope: "vera",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        stashRoot: "/home/user/.vera/stash",
    });

    expect(text).toContain("| Stash | Empty |");
    expect(text).toContain("| Filesystem | /home/user/.vera/stash |");
    expect(text).not.toContain("cp <key> <path>");
});

test("TUI diagnostics ranks repeated model failures worst first", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "ready",
        elapsed: "0s",
        scope: "vera",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        now: Date.parse("2026-08-19T15:00:00.000Z"),
        modelFailureLedgerPath: "/home/user/.vera/failures/ledger.jsonl",
        modelFailures: summariseModelFailures([
            {
                at: "2026-08-19T14:00:00.000Z",
                provider: "openai",
                model: "gpt-5.6-sol",
                kind: "provider_failure",
                detail: "rate limited",
                sessionId: "session-b",
            },
            {
                at: "2026-08-19T14:30:00.000Z",
                provider: "openrouter",
                model: "moonshotai/kimi-k3",
                kind: "no_visible_response",
                detail: "Model returned no visible response.",
                sessionId: "session-a",
            },
            {
                at: "2026-08-19T14:45:00.000Z",
                provider: "openrouter",
                model: "moonshotai/kimi-k3",
                kind: "no_visible_response",
                detail: "Model returned no visible response.",
                sessionId: "session-c",
                requestTokens: 80_004,
                requestTokensEstimated: true,
                allowance: {
                    kind: "prompt_tokens",
                    requested: 80_004,
                    available: 51_390,
                },
            },
        ]),
    });

    const kimi = text.indexOf("openrouter/moonshotai/kimi-k3");
    expect(kimi).toBeGreaterThan(-1);
    // Twice beats once, so the row worth acting on reads first.
    expect(kimi).toBeLessThan(text.indexOf("openai/gpt-5.6-sol"));
    expect(text).toContain("no visible response");
    expect(text).toContain(
        "| Ledger | /home/user/.vera/failures/ledger.jsonl |",
    );
    expect(text).toContain(
        "| Last request | 80,004 estimated tokens (attempted, not billed usage) |",
    );
    expect(text).toContain("| Allowance | 51,390 prompt tokens |");
});

test("TUI diagnostics says so when no model has failed", () => {
    const text = renderTuiDiagnostics({
        state: createTuiState(),
        activity: "ready",
        elapsed: "0s",
        scope: "vera",
        workspace: "/workspace",
        runningBackgroundAgents: 0,
        modelFailures: summariseModelFailures([]),
    });

    expect(text).toContain("No recorded model failures.");
});
