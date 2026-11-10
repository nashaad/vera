import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { requestModelWithRecovery } from "../../src/engine/recovery.ts";
import { createLearnedFactObserver } from "../../src/host/pool/learned-facts.ts";
import type { WorkerGlobals } from "../../src/host/pool/worker-globals.ts";
import { createPoolEffortPool } from "../../src/model/effort-pool.ts";
import { recordLearned } from "../../src/model/pool-file-store.ts";
import type { LearnedFact } from "../../src/model/pool-file.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter, type ModelRequest } from "../../src/model/types.ts";
import { ProviderRoutingAdapter } from "../../src/providers/routing.ts";

test("a learned refusal reaches the host before recovery retries", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7cl-"));
    const path = join(home, "pool.json");
    await writeFile(path, JSON.stringify({ models: { "stub/m": { efforts: { high: "high", medium: "medium" } } } }));
    const attempts: string[] = [];
    const calls: string[] = [];
    const globals = {
        async request(method: string, id: string, key: string, fact: LearnedFact) {
            calls.push(`${method}:${id}:${key}`);
            await Bun.sleep(20);
            recordLearned(id, { [key]: fact }, { path });
        },
    } as unknown as WorkerGlobals;
    const observer = createLearnedFactObserver(globals, home, () => {});
    const source: ModelAdapter = {
        stream(request) {
            const stream = new ModelEventStream();
            attempts.push(request.reasoningEffort ?? "");
            queueMicrotask(() => {
                stream.push({ type: "start" });
                if (request.reasoningEffort === "high") {
                    const error = new ProviderFailureError({
                        kind: "invalid_request", resolution: "user_action", statusCode: 400,
                        message: "reasoning_effort is not supported for this model",
                    }, undefined);
                    stream.push({ type: "error", error, message: message("error") });
                } else {
                    stream.push({ type: "done", message: message("stop") });
                }
            });
            return stream;
        },
    };
    const adapter = new ProviderRoutingAdapter(() => source, "stub", undefined, undefined,
        (request, event, started) => observer(home, request, event, started));
    const pool = { ...createPoolEffortPool({ userPath: path, path }), recordLearned: () => {} };
    try {
        const result = await requestModelWithRecovery(adapter, request("high"), {
            onEvent: () => {}, onRetry: () => {}, onFallback: () => {}, coarsening: { pool },
        });
        expect(result.stopReason).toBe("stop");
        expect(attempts).toEqual(["high", "medium"]);
        expect(calls).toEqual(["poolLearned:stub/m:efforts.high"]);
        const written = JSON.parse(await readFile(path, "utf8"));
        expect(written.models["stub/m"].learned["efforts.high"].ok).toBe(false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("partial and aborted failures do not record facts, and accepted images do", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "h7li-"));
    const path = join(home, "pool.json");
    const calls: string[] = [];
    const globals = {
        async request(method: string, id: string, key: string, fact: LearnedFact) {
            calls.push(`${method}:${id}:${key}`);
            recordLearned(id, { [key]: fact }, { path });
        },
    } as unknown as WorkerGlobals;
    const observer = createLearnedFactObserver(globals, home, () => {});
    const error = new ProviderFailureError({
        kind: "invalid_request", resolution: "user_action", statusCode: 400,
        message: "reasoning_effort is not supported for this model",
    }, undefined);
    const failure = { type: "error" as const, error, message: message("error") };
    const aborted = AbortSignal.abort();
    try {
        await observer(home, request("high"), failure, true);
        await observer(home, { ...request("high"), signal: aborted }, failure, false);
        expect(calls).toEqual([]);
        const withImage = { ...request("high"), messages: [{ role: "user", content: [{ type: "image", data: "aA==", mimeType: "image/png" }] }] } as unknown as ModelRequest;
        const done = { type: "done" as const, message: message("stop") };
        await observer(home, withImage, done, false);
        await observer(home, withImage, done, false);
        expect(calls).toEqual(["poolLearned:stub/m:images"]);
        const written = JSON.parse(await readFile(path, "utf8"));
        expect(written.models["stub/m"].learned.images.ok).toBe(true);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

function request(reasoningEffort: string): ModelRequest {
    return { provider: "stub", model: "m", reasoningEffort, systemPrompt: "", messages: [], tools: [] } as ModelRequest;
}

function message(stopReason: "stop" | "error"): AssistantMessage {
    return { role: "assistant", content: [], stopReason, source: { provider: "stub", api: "none", model: "m" }, usage: emptyUsage() };
}
