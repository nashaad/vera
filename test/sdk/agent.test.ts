import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vera } from "../../src/sdk/agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import type { VeraConfig } from "../../src/config.ts";

test("Agent.run owns a bounded tool-free engine loop without a resident host", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-sdk-test-"));
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "bounded answer" }],
        source: { provider: "faux", api: "test", model: "reviewer" },
        usage: {
            ...emptyUsage(),
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
        },
        stopReason: "stop",
    };
    const scripted = new FauxAdapter([response], { chunkSize: 3 });
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(next) {
            request = next;
            return scripted.stream(next);
        },
    };
    const config: VeraConfig = {
        schema_version: 1,
        provider: "faux",
        model: "reviewer",
        reasoning_effort: "high",
        approval_mode: "ask",
    };

    try {
        const vera = await Vera.create({
            config,
            workspace,
            createAdapter: () => adapter,
        });
        const result = await vera.agent().run("Review this patch");

        expect(result).toMatchObject({
            outcome: "completed",
            text: "bounded answer",
            model: { provider: "faux", model: "reviewer" },
            substitutions: [],
        });
        expect(result.usage?.rows).toEqual([
            expect.objectContaining({
                provider: "faux",
                model: "reviewer",
                inputTokens: 3,
                outputTokens: 2,
                totalTokens: 5,
                calls: 1,
            }),
        ]);
        expect(request?.model).toBe("reviewer");
        expect(request?.reasoningEffort).toBe("high");
        expect(request?.tools).toEqual([]);
        expect(JSON.stringify(request?.messages)).toContain("Review this patch");
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("Agent.run rejects an empty prompt before constructing an adapter", async () => {
    let adapters = 0;
    const vera = await Vera.create({
        config: {
            schema_version: 1,
            provider: "faux",
            model: "reviewer",
            approval_mode: "auto",
        },
        createAdapter() {
            adapters += 1;
            throw new Error("must not run");
        },
    });

    await expect(vera.agent().run("  ")).rejects.toThrow(
        "Agent prompt must not be empty",
    );
    expect(adapters).toBe(0);
});
