import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyModelOperation, eligibleForDefault, type ModelOperationOptions } from "../../src/model/model-operations.ts";
import { isCuratedPoolEntry, isVerifiedPoolEntry } from "../../src/model/pool-file.ts";
import { readUserPoolFile, recordModelVerification, removeProviderPoolModels } from "../../src/model/pool-file-store.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter } from "../../src/model/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const model = { provider: "test", model: "one" };
function options(): ModelOperationOptions {
    const dir = mkdtempSync(join(tmpdir(), "vera-model-ops-")); dirs.push(dir);
    return { path: join(dir, "pool.json"), discovered: [model, { ...model, model: "two" }], assignments: [],
        createAdapter: () => { throw new Error("No request was expected"); } };
}
const entry = (options: ModelOperationOptions) => readUserPoolFile(options).models["test/one"]!;

test("keep, rename, unkeep preserve independent evidence through real store reloads", async () => {
    const opts = options();
    await applyModelOperation({ operation: "keep", models: [model] }, opts);
    expect(isCuratedPoolEntry(entry(opts))).toBe(true);
    expect(isVerifiedPoolEntry(entry(opts))).toBe(false);
    recordModelVerification("test/one", { probe: { ok: true, seen: "2026-09-06" } }, opts);
    expect(eligibleForDefault(readUserPoolFile(opts), model)).toBe(true);
    await applyModelOperation({ operation: "rename", models: [model], displayName: "My Daily Model" }, opts);
    await applyModelOperation({ operation: "unkeep", models: [model] }, opts);
    expect(isCuratedPoolEntry(entry(opts))).toBe(false);
    expect(isVerifiedPoolEntry(entry(opts))).toBe(true);
    expect(entry(opts).displayName).toBe("My Daily Model");
    expect(eligibleForDefault(readUserPoolFile(opts), model)).toBe(true);
    await applyModelOperation({ operation: "keep", models: [model] }, opts);
    expect(entry(opts).displayName).toBe("My Daily Model");
    expect(isVerifiedPoolEntry(entry(opts))).toBe(true);
    await applyModelOperation({ operation: "rename", models: [model], displayName: "" }, opts);
    expect(entry(opts).displayName).toBeUndefined();
    expect(isCuratedPoolEntry(entry(opts))).toBe(true);
    expect(isVerifiedPoolEntry(entry(opts))).toBe(true);
});

test("rename of a discovered model does not keep or verify it", async () => {
    const opts = options();
    await applyModelOperation({ operation: "rename", models: [model], displayName: "A Name" }, opts);
    expect(isCuratedPoolEntry(entry(opts))).toBe(false);
    expect(isVerifiedPoolEntry(entry(opts))).toBe(false);
});

test("bulk unkeep leaves assigned models eligible", async () => {
    const opts = options();
    await applyModelOperation({ operation: "keep", models: opts.discovered }, opts);
    recordModelVerification("test/one", { probe: { ok: true, seen: "2026-09-16" } }, opts);
    const result = await applyModelOperation({ operation: "unkeep", models: opts.discovered }, {
        ...opts, assignments: [{ label: "compaction", models: [model] }],
    });
    expect(result.every((row) => row.status !== "failed")).toBe(true);
    expect(isCuratedPoolEntry(entry(opts))).toBe(false);
    expect(eligibleForDefault(readUserPoolFile(opts), model)).toBe(true);
});

test("verification makes real adapter requests and does not keep a model", async () => {
    const opts = options();
    const calls: string[] = [];
    const adapter: ModelAdapter = { stream(request) {
        calls.push(request.model);
        const tool = request.tools?.[0];
        const message: AssistantMessage = { role: "assistant", content: tool === undefined
            ? [{ type: "text", text: "vera-admission-ok" }]
            : [{ type: "tool_call", id: "call", name: tool.name, input: { value: "ok" } }],
            source: { provider: "test", api: "test", model: request.model },
            usage: emptyUsage(), stopReason: tool === undefined ? "stop" : "tool_use" };
        return { async *[Symbol.asyncIterator]() { yield { type: "done" as const, message }; },
            result: () => Promise.resolve(message) };
    } };
    const streamed: string[] = [];
    const results = await applyModelOperation({ operation: "verify", models: [model] }, {
        ...opts, createAdapter: () => adapter, onResult: (row) => streamed.push(row.status),
    });
    expect(results[0]?.status).toBe("passed");
    expect(calls.length).toBeGreaterThan(0);
    expect(streamed).toEqual(["passed"]);
    expect(isVerifiedPoolEntry(entry(opts))).toBe(true);
    expect(isCuratedPoolEntry(entry(opts))).toBe(false);
});

test("verification failure leaves membership and assignments untouched", async () => {
    const opts = options();
    await applyModelOperation({ operation: "keep", models: [model] }, opts);
    recordModelVerification("test/one", { probe: { ok: true, seen: "2026-09-06" } }, opts);
    const results = await applyModelOperation({ operation: "verify", models: [model] }, opts);
    expect(results[0]?.status).toBe("failed");
    expect(isCuratedPoolEntry(entry(opts))).toBe(true);
    expect(isVerifiedPoolEntry(entry(opts))).toBe(false);
    expect(entry(opts).learned?.probe?.error).toBe("No request was expected");
});

for (const fails of [false, true]) {
    test(`obsolete verification discards ${fails ? "failure" : "success"} and queued checks after reconnect`, async () => {
        const opts = options();
        let current = true;
        const started = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const calls: string[] = [];
        const adapter: ModelAdapter = { stream(request) {
            calls.push(request.model);
            started.resolve();
            const tool = request.tools?.[0];
            const message: AssistantMessage = { role: "assistant", content: tool === undefined
                ? [{ type: "text", text: "vera-admission-ok" }]
                : [{ type: "tool_call", id: "call", name: tool.name, input: { value: "ok" } }],
                source: { provider: "test", api: "test", model: request.model },
                usage: emptyUsage(), stopReason: tool === undefined ? "stop" : "tool_use" };
            return { async *[Symbol.asyncIterator]() {
                await gate.promise;
                if (fails) throw new Error("late failure");
                yield { type: "done" as const, message };
            }, result: async () => { await gate.promise; return message; } };
        } };
        const pending = applyModelOperation({ operation: "verify", models: opts.discovered }, {
            ...opts, createAdapter: () => adapter, isCurrent: () => current,
        });
        await started.promise;
        current = false;
        removeProviderPoolModels("test", opts);
        await applyModelOperation({ operation: "keep", models: [model] }, opts);
        const reconnected = readUserPoolFile(opts);
        gate.resolve();
        const results = await pending;
        expect(results).toHaveLength(2);
        expect(results.every((row) => row.status === "failed" && row.reason?.includes("discarded"))).toBe(true);
        expect(readUserPoolFile(opts)).toEqual(reconnected);
        expect(calls).not.toContain("two");
    });
}
