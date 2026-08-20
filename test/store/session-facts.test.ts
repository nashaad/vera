import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/store/session-store.ts";
import {
    latestFailureBySession,
    readSessionFacts,
} from "../../src/store/session-facts.ts";
import type { ModelMessage, ModelUsage } from "../../src/model/types.ts";
import type { ModelFailureRecord } from "../../src/store/model-failures.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
    return {
        inputTokens: 1_000,
        outputTokens: 100,
        cachedInputTokens: 400,
        reasoningTokens: 10,
        totalTokens: 1_110,
        cost: 0.02,
        ...overrides,
    };
}

function assistant(
    model: string,
    modelUsage: ModelUsage,
    durationMs = 500,
): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        source: { provider: "faux", api: "scripted", model },
        usage: modelUsage,
        durationMs,
        stopReason: "stop",
    } as ModelMessage;
}

async function writeSession(name: string): Promise<string> {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-facts-"));
    temporaryDirectories.push(directory);
    const path = join(directory, `${name}.jsonl`);
    const store = await SessionStore.create(path, {
        sessionId: name,
        cwd: "/work/vera",
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
    });
    await store.appendMessage(assistant("small", usage()));
    await store.appendMessage({
        role: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
    });
    await store.appendMessage(assistant("small", usage({ cost: undefined })));
    await store.appendMessage(assistant("large", usage({
        inputTokens: 40_000,
        totalTokens: 40_500,
        outputTokens: 500,
        cost: 1,
    })));
    return path;
}

test("session facts fold a real session file back into usage and context", async () => {
    const path = await writeSession("facts");
    const facts = await readSessionFacts(path, {
        include: ["usage", "context", "model"],
        capacity: (_provider, model) => model === "large" ? 200_000 : undefined,
    });

    const small = facts.usage?.rows.find((row) => row.model === "small");
    expect(small?.calls).toBe(2);
    expect(small?.inputTokens).toBe(2_000);
    expect(small?.cost).toBeCloseTo(0.02);
    // One of the two calls priced nothing, and that is recorded rather than
    // rolled into the total as a zero.
    expect(small?.callsWithoutCost).toBe(1);
    expect(small?.durationMs).toBe(1_000);

    // Context is the provider's count for the most recent request only.
    expect(facts.context?.tokens).toBe(40_000);
    expect(facts.context?.capacity).toBe(200_000);
    expect(facts.contextMeasuredAt).toBeDefined();
    expect(facts.model).toEqual({ provider: "faux", model: "large" });
});

test("facts not asked for are never computed", async () => {
    const path = await writeSession("selective");
    const facts = await readSessionFacts(path, { include: ["context"] });

    expect(facts.usage).toBeUndefined();
    expect(facts.model).toBeUndefined();
    expect(facts.context?.tokens).toBe(40_000);

    expect(await readSessionFacts(path, { include: [] })).toEqual({});
    expect(await readSessionFacts(path, { include: ["failure"] })).toEqual({});
});

test("an unknown model leaves the capacity absent rather than guessed", async () => {
    const path = await writeSession("uncapped");
    const facts = await readSessionFacts(path, { include: ["context"] });
    expect(facts.context?.tokens).toBe(40_000);
    expect(facts.context?.capacity).toBeUndefined();
});

test("an unreadable session contributes no facts and does not throw", async () => {
    const facts = await readSessionFacts("/nonexistent/session.jsonl", {
        include: ["usage", "context", "model"],
    });
    expect(facts).toEqual({});
});

test("the failure ledger reduces to the latest record per session", () => {
    const record = (
        sessionId: string,
        at: string,
        detail: string,
    ): ModelFailureRecord => ({
        at,
        provider: "faux",
        model: "small",
        kind: "provider_failure",
        detail,
        sessionId,
    });
    const latest = latestFailureBySession([
        record("a", "2026-08-20T10:00:00.000Z", "first"),
        record("b", "2026-08-20T11:00:00.000Z", "other session"),
        record("a", "2026-08-20T12:00:00.000Z", "newest"),
    ]);

    expect(latest.size).toBe(2);
    expect(latest.get("a")?.detail).toBe("newest");
    expect(latest.get("b")?.detail).toBe("other session");
});
