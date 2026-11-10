import { expect, test } from "bun:test";
import { loopbackTest, socketAndLoopbackTest } from "../support/socket-probe.ts";
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
import { checkFailed, collectResult, footprintDetails, table } from "../../dev/load/results.ts";
import { parseLoadOptions } from "../../dev/load/options.ts";
import { CLIENT_CAPABILITIES, HOST_CAPABILITY_AGENT_HISTORY_PAGING, HOST_CAPABILITY_SESSION_ROUTING } from "../../src/host/capabilities.ts";

async function trial(): Promise<string> {
    const base = join(tmpdir(), "vera-dev");
    await mkdir(base, { recursive: true });
    return mkdtemp(join(base, "load-test-"));
}

loopbackTest("faux streaming uses the chat adapter with paced chunks, tools and usage", async () => {
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

loopbackTest("scripted turns have six to twelve rounds, a final reply, and plain side replies", async () => {
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
            let hasToolResult = false;
            const head = store.activeHeadId();
            if (head !== null) {
                for await (const entry of store.walkMessageBranch(head)) {
                    if (entry.message.role === "tool_result") {
                        hasToolResult = true;
                        break;
                    }
                }
            }
            expect(hasToolResult).toBe(true);
            expect(store.usageSummary().rows.some((row) => row.cost! > 0)).toBe(true);
            expect(Math.abs(row.bytes - row.targetBytes)).toBeLessThan(10_000);
        }
        expect(summarizeStash(join(root, "factory", "home", "runtime", "stash"))?.sessions).toBe(8);
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
    expect(() => assertTrialHome("/tmp/unsafe-load-home")).toThrow();
});

test("load options select routed attachments by default and relay explicitly", () => {
    expect(parseLoadOptions([]).scenario).toMatchObject({ relay: false, paging: false });
    expect(parseLoadOptions(["--relay"]).scenario).toMatchObject({ relay: true, paging: false });
    expect(parseLoadOptions(["--paging"]).scenario).toMatchObject({ relay: false, paging: true });
    expect(parseLoadOptions(["--relay", "--paging"]).scenario).toMatchObject({ relay: true, paging: true });
    expect(() => parseLoadOptions(["--relai"])).toThrow();
});

test("result rows label the attach path and count observed destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "load-attachment-metrics-"));
    const write = async (samples: unknown[]): Promise<void> => {
        await Bun.write(join(root, "client-0-0.ndjson"), samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
    };
    const scenario = { sessions: 2, clients: 1, duration: 1, extensions: "none" as const, seed: 1, small: true };
    const footprint = { start: { bytes: null, path: "" }, end: { bytes: null, path: "" } };
    try {
        await Bun.write(join(root, "provider.ndjson"), [
            { at: 900, type: "request", markerLost: true },
            { at: 1_100, type: "request", markerLost: true },
            { at: 1_200, type: "tokens", markerLost: true },
            { at: 1_300, type: "request" },
            { at: 2_100, type: "request", markerLost: true },
        ].map((row) => JSON.stringify(row)).join("\n") + "\n");
        await write([
            { at: 1_100, type: "attach_path", id: "a", via: "routed", connection: 1 },
            { at: 1_200, type: "attach_path", id: "a", via: "direct", connection: 2 },
            { at: 1_300, type: "attach_path", id: "b", via: "routed", connection: 3 },
        ]);
        const routed = collectResult(root, scenario, 1_000, 2_000, "test", footprint, []);
        expect(routed.attachments).toEqual({ path: "routed", direct: 1, routed: 1, unknown: 0 });
        expect(routed.rates).toMatchObject({ modelRequests: 2, markerLostRequests: 1 });
        expect(table([routed])).toContain("| pool | routed | 1 | 1 | 0 |");
        const [headings, , values] = table([routed]).trim().split("\n");
        expect(values!.split("|")[headings!.split("|").indexOf(" Marker lost ")]).toBe(" 1 ");
        await write([
            { at: 1_100, type: "attach_path", id: "a", via: "routed", connection: 1 },
            { at: 1_200, type: "attach_path", id: "b", via: "routed", connection: 2 },
        ]);
        const relay = collectResult(root, { ...scenario, relay: true }, 1_000, 2_000, "test", footprint, []);
        expect(relay.attachments).toEqual({ path: "relay", direct: 0, routed: 2, unknown: 0 });
        expect(table([relay])).toContain("| pool | relay | 0 | 2 | 0 |");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("process metrics keep per-process peaks and sum only simultaneous footprint samples", async () => {
    const root = await mkdtemp(join(tmpdir(), "load-metrics-"));
    const write = async (name: string, samples: unknown[]): Promise<void> => {
        await Bun.write(join(root, name), samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
    };
    try {
        await write("probe.ndjson", [{ at: 1_200, type: "process", cpu: 10, rssBytes: 100,
            hosts: [{ pid: 1, role: "host", cpu: 10, rssBytes: 100 }, { pid: 2, role: "w0-g1", cpu: 20, rssBytes: 200 }] }]);
        await write("drift.ndjson", [{ at: 1_200, delayMs: 4 }]);
        await write("drift-worker-2.ndjson", [{ at: 1_200, delayMs: 12 }, { at: 1_300, delayMs: 25 }]);
        await write("footprints.ndjson", [
            { at: 1_000, phase: "ready", processes: [{ pid: 1, role: "host", bytes: 100 }, { pid: 2, role: "w0-g1", bytes: 200 }] },
            { at: 1_300, phase: "sample", processes: [{ pid: 1, role: "host", bytes: 200 }, { pid: 2, role: "w0-g1", bytes: 200 }] },
            { at: 1_600, phase: "sample", processes: [{ pid: 1, role: "host", bytes: 100 }, { pid: 2, role: "w0-g1", bytes: 400 }] },
            { at: 2_000, phase: "end", processes: [{ pid: 1, role: "host", bytes: 120 }, { pid: 2, role: "w0-g1", bytes: 250 }] },
        ]);
        const result = collectResult(root, { sessions: 1, clients: 1, duration: 1, extensions: "none", seed: 1, small: true },
            1_000, 2_000, "test", { start: { bytes: null, path: "" }, end: { bytes: null, path: "" } }, []);
        expect(result.totalCpuPercent.mean).toBe(30);
        expect(result.totalRssBytes.peak).toBe(300);
        expect(result.physicalFootprint).toMatchObject({ ready: 300, peak: 500, end: 370 });
        expect(result.physicalFootprint.processes.map((process) => process.peak)).toEqual([200, 400]);
        expect(result.workerEventLoopDelayMs).toMatchObject({ p99: 25, max: 25 });
        expect(footprintDetails(result)).toContain("w0-g1 (PID 2): n/a/0.0/0.0/0.0");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("pin results separate owned errors and retain a worker loss as a finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "load-pin-metrics-"));
    const write = async (name: string, samples: unknown[]): Promise<void> => {
        await Bun.write(join(root, name), samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
    };
    try {
        await mkdir(join(root, "home", "runtime", "logs"), { recursive: true });
        await write("pin.ndjson", [{ at: 1_100, pid: 2, worker: 0, type: "start" }]);
        await write("pin-owners.ndjson", [{ id: "one", worker: "w0" }, { id: "two", worker: "w1" }]);
        await write("drift-worker-2.ndjson", [{ at: 1_200, delayMs: 160 }, { at: 1_500, delayMs: 180 }]);
        await write("probe.ndjson", [
            { at: 1_200, type: "process", cpu: 5, rssBytes: 100, hosts: [{ pid: 2, role: "w0-g1", cpu: 90, rssBytes: 200 }] },
            { at: 1_300, type: "identity_uncapped", ms: 5 },
            { at: 1_400, type: "diagnostics", ms: 25 },
            { at: 1_600, startedAt: 1_200, type: "diagnostics_failed", ms: 400 },
            { at: 1_900, startedAt: 1_700, type: "identity_uncapped", ms: 1_000 },
            { at: 2_100, startedAt: 1_700, type: "diagnostics", ms: 2_000 },
        ]);
        await write("client-0.ndjson", [{ at: 1_600, type: "error", id: "one", error: "owned failure" },
            { at: 1_700, type: "error", id: "two", error: "other failure" }]);
        await write("home/runtime/logs/host.jsonl", [{ timestamp: new Date(1_800).toISOString(), type: "session_process_lost",
            pid: 2, reason: "heartbeat_timeout", exit_code: null, signal: "SIGKILL" }]);
        const result = collectResult(root, { sessions: 2, clients: 1, duration: 1, extensions: "none", seed: 1, small: true, pinWorker: true },
            1_000, 2_000, "test", { start: { bytes: null, path: "" }, end: { bytes: null, path: "" } }, []);
        expect(result.pin).toMatchObject({ pid: 2, sessions: ["one"], ownedErrors: 1, otherErrors: 1,
            loss: { reason: "heartbeat_timeout", signal: "SIGKILL" }, eventLoopDelayMs: { p99: 180, max: 180 },
            identityLatencyMs: { p90: 1_000, max: 1_000 }, agentListLatencyMs: { p90: 2_000, max: 2_000 }, agentListFailures: 1 });
        expect(result.errors).toEqual(["owned failure", "other failure"]);
        const lines = table([result]).trim().split("\n");
        expect(lines[2]).toContain("heartbeat_timeout");
        expect(lines[0]!.split("|").length).toBe(lines[2]!.split("|").length);
    } finally { await rm(root, { recursive: true, force: true }); }
});

socketAndLoopbackTest("startup limits connection bursts and the smoke records measurements", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    try {
        const result = await runScenario({ sessions: 2, clients: 5, duration: 15, extensions: "included", seed: 7, small: true, workers: 0 }, root);
        expect(result.errors).toEqual([]);
        expect(result.readyClients).toBe(10);
        expect(result.attachments).toEqual({ path: "routed", direct: 0, routed: 10, unknown: 0 });
        expect(result.rates.modelRequests).toBeGreaterThan(0);
        expect(result.rates.streamedTokens).toBeGreaterThan(0);
        expect(result.hostCpuPercent.count).toBeGreaterThan(0);
        expect(result.hostRssBytes.peak).toBeGreaterThan(0);
        expect(result.totalCpuPercent.count).toBeGreaterThan(0);
        expect(result.totalRssBytes.peak).toBeGreaterThan(0);
        expect(result.physicalFootprint.processes.map((process) => process.role)).toEqual(["host"]);
        expect(result.workerEventLoopDelayMs.processes).toEqual([]);
        expect(result.eventLoopDelayMs.count).toBeGreaterThan(0);
        expect(result.identityLatencyMs.count).toBeGreaterThan(0);
        expect(result.diagnosticsLatencyMs.count).toBeGreaterThan(0);
        expect(result.attachLatencyMs.count).toBeGreaterThan(0);
        expect(result.workerCount.max).toBe(0);
        expect(result.footprint.start.path).not.toBe("");
        expect(result.footprint.end.path).not.toBe("");
        expect(result.stop?.commandExit).toBe(0);
        expect(result.stop?.elapsedMs).toBeGreaterThan(0);
        expect(result.stop?.awakeElapsedMs).toBeGreaterThan(0);
        expect(result.stop?.remainingPids).toEqual([]);
        expect(result.stop?.remainingRecords).toEqual([]);
        const timing = await Bun.file(join(result.run, "measurement-timing.json")).json();
        expect(timing.wallMs).toBeGreaterThan(0);
        expect(timing.awakeMs).toBeGreaterThan(0);
        expect(await Bun.file(join(result.run, "result.json")).exists()).toBe(true);
        const pids = await Bun.file(join(result.run, "pids.ndjson")).text();
        expect(pids).toContain('"type":"cleanup","survivors":[]');
        const starts = pids.trim().split("\n").map((line) => JSON.parse(line));
        const fifth = starts.find((entry) => entry.type === "start" && entry.role === "client-4-0");
        const first = (await Bun.file(join(result.run, "client-0-0.ndjson")).text()).trim().split("\n")
            .map((line) => JSON.parse(line));
        const attached = first.filter((entry) => entry.type === "attach_path");
        expect(attached).toHaveLength(2);
        expect(attached[0].capabilities).toEqual([...CLIENT_CAPABILITIES]);
        expect(attached[0].interactive).toBe(true);
        const ready = first.filter((entry) => entry.type === "ready");
        expect(ready).toHaveLength(2);
        expect(fifth.at).toBeGreaterThanOrEqual(Math.max(...ready.map((entry) => entry.at)));
        expect(checkFailed({ ...result, scenario: { ...result.scenario, sessions: 100 }, identityMisses: 1 })).toBe(true);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 90_000);

for (const relay of [false, true]) socketAndLoopbackTest(`paging works with ${relay ? "relay" : "routed"} attachments`, async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    try {
        const result = await runScenario({ sessions: 1, clients: 1, duration: 5, extensions: "included", seed: 7,
            small: true, workers: 1, relay, paging: true }, root);
        expect(result.errors).toEqual([]);
        expect(result.attachments).toEqual({ path: relay ? "relay" : "routed", direct: relay ? 0 : 1, routed: relay ? 1 : 0, unknown: 0 });
        const events = (await Bun.file(join(result.run, "client-0-0.ndjson")).text()).trim().split("\n").map((line) => JSON.parse(line));
        const attached = events.find((event) => event.type === "attach_path");
        expect(attached.capabilities).toContain(HOST_CAPABILITY_AGENT_HISTORY_PAGING);
        expect(attached.capabilities.includes(HOST_CAPABILITY_SESSION_ROUTING)).toBe(!relay);
        expect(attached.interactive).toBe(!relay);
        expect(events.some((event) => event.type === "paged")).toBe(true);
        const probe = (await Bun.file(join(result.run, "probe.ndjson")).text()).trim().split("\n").map((line) => JSON.parse(line));
        expect(probe.find((event) => event.type === "attach_path")?.via).toBe(relay ? "routed" : "direct");
        expect(result.stop?.remainingPids).toEqual([]);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 90_000);

socketAndLoopbackTest("worker kill reconnects affected clients and leaves the other worker serving", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    try {
        const result = await runScenario({ sessions: 2, clients: 1, duration: 15, extensions: "included", seed: 7, small: true, workers: 2, killWorker: true }, root);
        expect(result.errors).toEqual([]);
        expect(result.kill).not.toBeNull();
        expect(result.kill!.target).toMatch(/^crow-/);
        expect(result.kill!.sessions).toContain(result.kill!.target);
        expect(result.kill!.failedRecords).toBe(1);
        expect(result.kill!.reattachedClients).toBe(result.kill!.expectedClients);
        expect(result.kill!.reattachMs).toBeGreaterThan(0);
        expect(result.kill!.otherErrors).toBe(0);
        expect(result.attachments).toEqual({ path: "routed", direct: 2, routed: 0, unknown: 0 });
        const replacement = result.physicalFootprint.processes.find((process) => process.role === `${result.kill!.worker}-g2`);
        expect(replacement?.ready).toBeGreaterThan(0);
        expect(result.stop?.remainingPids).toEqual([]);
        expect(result.stop?.remainingRecords).toEqual([]);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 90_000);

socketAndLoopbackTest("worker pin samples the selected process for the measured window", async () => {
    const root = await trial();
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "control");
    try {
        const result = await runScenario({ sessions: 2, clients: 1, duration: 15, extensions: "included", seed: 7, small: true, workers: 2, pinWorker: true }, root);
        expect(result.errors).toEqual([]);
        expect(result.pin?.worker).toBe(0);
        expect(result.attachments).toEqual({ path: "routed", direct: 2, routed: 0, unknown: 0 });
        expect(result.pin?.iterations).toBeGreaterThan(0);
        expect(result.pin?.cpuPercent.count).toBeGreaterThan(0);
        expect(result.pin?.eventLoopDelayMs.p99).toBeGreaterThan(50);
        expect(result.workerEventLoopDelayMs.processes.map((process) => process.pid)).toContain(result.pin!.pid);
        expect(result.stop?.remainingPids).toEqual([]);
        expect(result.stop?.remainingRecords).toEqual([]);
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 90_000);
