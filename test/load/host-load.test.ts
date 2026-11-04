import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCustomOpenAIAdapter } from "../../src/providers/custom-openai.ts";
import { readTool } from "../../src/tools/files.ts";
import { editTool } from "../../src/tools/edit.ts";
import { grepTool } from "../../src/tools/grep.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { summarizeStash } from "../../src/store/preimage-stash.ts";
import type { ModelMessage } from "../../src/model/types.ts";
import { startProvider } from "../../dev/load/provider.ts";
import { buildFactory, targetSizes } from "../../dev/load/factory.ts";
import { runScenario } from "../../dev/load/run.ts";
import { assertTrialHome } from "../../dev/load/common.ts";
import { checkFailed } from "../../dev/load/results.ts";

async function trial(): Promise<string> {
    const base = join(tmpdir(), "vera-dev");
    await mkdir(base, { recursive: true });
    return mkdtemp(join(base, "load-test-"));
}

test("faux streaming uses the chat adapter with paced chunks, tools and usage", async () => {
    const server = startProvider({ seed: 1 });
    try {
        const adapter = createCustomOpenAIAdapter({ provider: "faux-0", baseUrl: `http://127.0.0.1:${server.port}/v1` });
        const started = performance.now();
        const stream = adapter.stream({ model: "crow-0", messages: [{ role: "user", content: [{ type: "text", text: "LOAD_TURN:crow-0000:0 Sail." }] }], tools: [readTool.definition, editTool.definition, grepTool.definition] });
        const times: number[] = [];
        for await (const event of stream) {
            if (event.type === "tool_call_delta") times.push(performance.now());
        }
        const message = await stream.result();
        expect(message.stopReason).toBe("tool_use");
        expect(message.content[0]).toMatchObject({ type: "tool_call", name: "read", input: { path: "sessions/crow-0000.txt" } });
        expect(message.usage.inputTokens).toBeGreaterThan(0);
        expect(message.usage.outputTokens).toBe(36);
        expect(times.length).toBeGreaterThan(3);
        expect(times[0]! - started).toBeGreaterThanOrEqual(580);
        expect(times[0]! - started).toBeLessThan(2000);
        const gaps = times.slice(1).map((time, index) => time - times[index]!);
        expect(gaps.filter((gap) => gap >= 30 && gap < 150).length).toBeGreaterThanOrEqual(gaps.length - 1);
    } finally { server.stop(true); }
}, 10_000);

test("scripted turns have six to twelve rounds, a final reply, and plain side replies", async () => {
    const server = startProvider({ seed: 19, speed: 100 });
    try {
        const adapter = createCustomOpenAIAdapter({ provider: "faux-0", baseUrl: `http://127.0.0.1:${server.port}/v1` });
        const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "LOAD_TURN:crow-0001:4 Sail." }] }];
        const tools: string[] = [];
        for (let i = 0; i < 14; i++) {
            const reply = await adapter.stream({ model: "crow-0", messages, tools: [readTool.definition, editTool.definition, grepTool.definition] }).result();
            messages.push(reply);
            if (reply.stopReason === "stop") {
                expect(reply.usage.outputTokens).toBeGreaterThanOrEqual(300);
                expect(reply.usage.outputTokens).toBeLessThanOrEqual(800);
                break;
            }
            const call = reply.content.find((content) => content.type === "tool_call");
            if (!call || call.type !== "tool_call") throw new Error("Missing scripted call");
            tools.push(call.name);
            messages.push({ role: "tool_result", toolCallId: call.id, toolName: call.name, isError: false, content: [{ type: "text", text: "Chart checked." }] });
        }
        expect(tools.length).toBeGreaterThanOrEqual(6);
        expect(tools.length).toBeLessThanOrEqual(12);
        expect(new Set(tools)).toEqual(new Set(["read", "edit", "grep"]));
        expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
        const side = await adapter.stream({ model: "crow-0", messages: [{ role: "user", content: [{ type: "text", text: "Summarize the voyage." }] }] }).result();
        expect(side.stopReason).toBe("stop");
        expect(side.content[0]?.type).toBe("text");
    } finally { server.stop(true); }
}, 10_000);

test("factory uses readable sessions, billed compactions and stash sidecars", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    try {
        const manifest = await buildFactory({ root: join(root, "factory"), workspace: join(root, "active", "workspace"), seed: 3, small: true });
        for (const row of manifest.sessions) {
            const store = await SessionStore.open(join(root, "factory", "home", "runtime", "sessions", `${row.id}.jsonl`));
            expect(store.header.id).toBe(row.id);
            expect(store.messages().some((message) => message.role === "tool_result")).toBe(true);
            expect(store.usageMessages().some((message) => message.usage.cost! > 0)).toBe(true);
            expect(Math.abs(row.bytes - row.targetBytes)).toBeLessThan(10_000);
        }
        expect(summarizeStash(join(root, "factory", "home", "runtime", "stash"))?.sessions).toBe(3);
        const sizes = targetSizes();
        expect(sizes.length).toBe(2300);
        expect(Math.abs(sizes.reduce((a, b) => a + b, 0) - 545e6)).toBeLessThan(3000);
        expect(sizes.filter((bytes) => bytes >= 20e6).length).toBe(8);
        expect(sizes.filter((bytes) => bytes >= 1e6 && bytes <= 10e6).length).toBe(40);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
});

test("runner refuses homes outside the trial tree", () => {
    expect(() => assertTrialHome("/private/tmp/unsafe-load-home")).toThrow();
});

test("two-session smoke records every measurement and cleans up", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    try {
        const result = await runScenario({ sessions: 2, clients: 1, duration: 15, extensions: "included", seed: 7, small: true }, root);
        expect(result.errors).toEqual([]);
        expect(result.readyClients).toBe(2);
        expect(result.rates.modelRequests).toBeGreaterThan(0);
        expect(result.rates.streamedTokens).toBeGreaterThan(0);
        expect(result.hostCpuPercent.count).toBeGreaterThan(0);
        expect(result.hostRssBytes.peak).toBeGreaterThan(0);
        expect(result.eventLoopDelayMs.count).toBeGreaterThan(0);
        expect(result.identityLatencyMs.count).toBeGreaterThan(0);
        expect(result.diagnosticsLatencyMs.count).toBeGreaterThan(0);
        expect(result.attachLatencyMs.count).toBeGreaterThan(0);
        expect(result.workerCount.max).toBe(0);
        expect(result.footprint.start.path).not.toBe("");
        expect(result.footprint.end.path).not.toBe("");
        expect(await Bun.file(join(result.run, "result.json")).exists()).toBe(true);
        const pids = await Bun.file(join(result.run, "pids.ndjson")).text();
        expect(pids).toContain('"type":"cleanup","survivors":[]');
        expect(checkFailed({ ...result, scenario: { ...result.scenario, sessions: 100 }, identityMisses: 1 })).toBe(true);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 90_000);
