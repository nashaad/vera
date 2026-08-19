import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModelFailureRecorder } from "../../src/engine/model-failure-recorder.ts";
import {
    ModelFailureLedger,
    readModelFailures,
} from "../../src/store/model-failures.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";

function ledgerPath(): string {
    return join(mkdtempSync(join(tmpdir(), "vera-recorder-")), "ledger.jsonl");
}

function assistantMessage(
    overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        source: {
            provider: "openrouter",
            api: "openrouter-chat",
            model: "moonshotai/kimi-k3",
        },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: "Model returned no visible response or structured tool call.",
        ...overrides,
    };
}

function recorded(
    events: readonly Parameters<ReturnType<typeof createModelFailureRecorder>>[0][],
): ReturnType<typeof readModelFailures> {
    const path = ledgerPath();
    const recorder = createModelFailureRecorder({
        ledger: new ModelFailureLedger(path),
        sessionId: "session-a",
    });
    for (const event of events) recorder(event);
    const records = readModelFailures(path);
    rmSync(path, { force: true });
    return records;
}

test("a turn that reasoned and said nothing is recorded by its own kind", () => {
    const records = recorded([
        { type: "turn_finished", message: assistantMessage() },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("no_visible_response");
    expect(records[0]?.model).toBe("moonshotai/kimi-k3");
    expect(records[0]?.sessionId).toBe("session-a");
});

test("a turn that succeeded is not recorded", () => {
    expect(recorded([{
        type: "turn_finished",
        message: assistantMessage({ stopReason: "stop", errorMessage: undefined }),
    }])).toEqual([]);
});

// An abort is the user stopping the model, not the model failing.
test("an aborted turn is not recorded", () => {
    expect(recorded([{
        type: "turn_finished",
        message: assistantMessage({ stopReason: "aborted" }),
    }])).toEqual([]);
});

// The ledger exists to say "your model or provider is the problem", which an
// attachment Vera could not read never is.
test("Vera's own synthesised failure is not recorded", () => {
    expect(recorded([{
        type: "turn_finished",
        message: assistantMessage({
            source: { provider: "vera", api: "attachment", model: "none" },
            errorMessage: "Image attachment unavailable: missing",
        }),
    }])).toEqual([]);
});

test("a provider failure carries the provider's own error detail", () => {
    const records = recorded([
        {
            type: "model_stream_error",
            error: "429",
            errorName: "ProviderFailureError",
            failure: {
                kind: "rate_limit",
                resolution: "retry",
                message: "rate limited",
                statusCode: 429,
                providerErrorType: "rate_limit_error",
                providerName: "Moonshot",
            },
            message: assistantMessage(),
        },
        { type: "turn_finished", message: assistantMessage() },
    ]);
    expect(records[0]?.kind).toBe("provider_failure");
    expect(records[0]?.statusCode).toBe(429);
    expect(records[0]?.providerName).toBe("Moonshot");
});

// A stream error the engine recovered from never ends a turn, so attributing
// it to the next turn's failure would blame the wrong thing.
test("a stream error from an earlier turn does not colour a later failure", () => {
    const records = recorded([
        {
            type: "model_stream_error",
            error: "429",
            errorName: "ProviderFailureError",
            failure: {
                kind: "rate_limit",
                resolution: "retry",
                message: "rate limited",
            },
            message: assistantMessage(),
        },
        {
            type: "turn_started",
            message: { role: "user", content: [{ type: "text", text: "hi" }] },
        },
        { type: "turn_finished", message: assistantMessage() },
    ]);
    expect(records[0]?.kind).toBe("no_visible_response");
});
