import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop, runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { transformMessages } from "../../src/model/transform.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter, type ModelMessage, type ModelRequest } from "../../src/model/types.ts";
import { encodeOpenRouterMessages } from "../../src/providers/openrouter-wire.ts";
import { createSessionBranch } from "../../src/store/session-branch.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const source = { provider: "faux", api: "scripted", model: "test" };

test("prefix commits keep branches and normal requests in call order", async () => {
    const lastHeld = await runBatch(false);
    const firstHeld = await runBatch(true);
    expect(lastHeld).toBe(firstHeld);
    const before: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "Inspect the crew" }] },
        batchResponse(),
        ...[["first", "first result"], ["fast", "hooked fast result"], ["last", "last result"]].map(([id, text]) => ({
            role: "tool_result" as const, toolCallId: id!, toolName: "crow_probe",
            content: [{ type: "text" as const, text: text! }], isError: false,
        })),
    ];
    expect(lastHeld).toBe(JSON.stringify(encodeOpenRouterMessages(
        undefined, transformMessages(before, { target: source }), "test",
    )));
    const messages = JSON.parse(lastHeld) as Array<Record<string, unknown>>;
    expect(messages.filter((message) => message.role === "tool")).toEqual([
        { role: "tool", toolCallId: "first", content: "first result" },
        { role: "tool", toolCallId: "fast", content: "hooked fast result" },
        { role: "tool", toolCallId: "last", content: "last result" },
    ]);
}, 20_000);

test("a checkpoint during a batch keeps its notice and delays presentations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-batch-checkpoint-"));
    const path = join(root, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
    const response: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "tool_call", id: "fast", name: "agent_roster", input: { details: false } },
            { type: "tool_call", id: "slow", name: "agent_roster", input: { details: true } },
        ],
        source, usage: emptyUsage(), stopReason: "tool_use",
    };
    const final: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Done" }],
        source, usage: emptyUsage(), stopReason: "stop",
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let fastSaved!: () => void;
    const saved = new Promise<void>((resolve) => { fastSaved = resolve; });
    store.watchRecords((_line, record) => {
        const message = record.message as { toolCallId?: string } | undefined;
        if (message?.toolCallId === "fast") fastSaved();
    });
    const resident = new ResidentAgent("crow", root);
    const attachment = resident.attach();
    const loop = runHeadlessLoop(resident.engine, new FauxAdapter([response, final]), "test", undefined, {
        enabledToolEffects: ["agent_roster"],
    }, {
        sessionStore: store,
        applyToolEffect: async (effect) => {
            if (effect.type !== "agent_roster") throw new Error("Unexpected effect");
            if (effect.details === true) {
                await gate;
                return { kind: "output", output: "slow result", isError: false };
            }
            return {
                kind: "output", output: "fast result", isError: false,
                presentation: { kind: "unified_diff", path: "deck.txt", patch: "@@\n-old\n+new\n" },
            };
        },
    });
    void loop.catch(() => {});
    try {
        resident.sendPrompt("Inspect the crew");
        await Promise.race([
            saved,
            Bun.sleep(5_000).then(() => { throw new Error("Fast result was not committed"); }),
        ]);
        resident.appendHarnessMessage("Crew notice", "soft");
        let sawPresentation = false;
        while (true) {
            const update = await attachment.receive(AbortSignal.timeout(5_000));
            if (update.type === "tool_presentation") sawPresentation = true;
            if (update.type !== "history" || !update.entries.some((entry) => entry.kind === "harness" && entry.text === "Crew notice")) continue;
            expect(update.entries.filter((entry) => entry.kind === "tool_result")).toHaveLength(0);
            expect(sawPresentation).toBe(false);
            break;
        }
        release();
        while (true) {
            const update = await attachment.receive(AbortSignal.timeout(5_000));
            if (update.type === "tool_presentation") sawPresentation = true;
            if (update.type === "turn_finished") break;
        }
        expect(sawPresentation).toBe(true);
        expect((await SessionStore.open(path)).projectedHarnessMessages()).toEqual([
            { afterMessage: 2, id: "harness:0", text: "Crew notice", tone: "soft" },
        ]);
    } finally {
        release();
        attachment.detach();
        resident.close();
        await loop.catch(() => {});
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

test("a failed prefix append does not write a later result", async () => {
    const response: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "tool_call", id: "first", name: "agent_roster", input: {} },
            { type: "tool_call", id: "second", name: "agent_roster", input: {} },
        ],
        source, usage: emptyUsage(), stopReason: "tool_use",
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const writes: string[] = [];
    const runtime = new ToolRuntime(process.cwd());
    const state: RunTurnState = {
        messages: [], events, hooks: new ToolHooks(), toolRuntime: runtime,
        inbound: new InboundCommandRouter(channel.engine, events),
        approvalMode: "auto", enabledToolEffects: ["agent_roster"],
        store: {
            async appendMessage(message) {
                if (message.role === "tool_result") {
                    writes.push(message.toolCallId);
                    if (message.toolCallId === "first") throw new Error("disk full");
                }
                return { id: "entry", message };
            },
        },
        applyToolEffect: async () => ({ kind: "output", output: "clear", isError: false }),
    };
    channel.client.send({ type: "prompt", content: "Inspect the crew" });
    try {
        await expect(runTurn(new FauxAdapter([response]), "test", state)).rejects.toThrow("disk full");
        expect(writes).toEqual(["first"]);
    } finally {
        await runtime.close();
    }
});

test("an inbox acknowledgement follows its durable result before a slow call settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-batch-inbox-"));
    const path = join(root, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
    const response: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "tool_call", id: "inbox", name: "crow_inbox", input: {} },
            { type: "tool_call", id: "slow", name: "agent_roster", input: { details: true } },
        ],
        source, usage: emptyUsage(), stopReason: "tool_use",
    };
    const final: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Done" }],
        source, usage: emptyUsage(), stopReason: "stop",
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let slowStarted!: () => void;
    const started = new Promise<void>((resolve) => { slowStarted = resolve; });
    let acknowledged!: () => void;
    const ack = new Promise<void>((resolve) => { acknowledged = resolve; });
    let slowSettled = false;
    let acknowledgedEffect: unknown;
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const runtime = new ToolRuntime(root);
    const inboxTool: RegisteredTool = {
        parallel: true, effectType: "agent_inbox", permissionOperation: "agent.roster",
        definition: { name: "crow_inbox", description: "Read the inbox", inputSchema: { type: "object", properties: {} } },
        async execute() {
            return { kind: "effect", effect: { type: "agent_inbox" } };
        },
    };
    const state: RunTurnState = {
        messages: [], store, events, toolRuntime: runtime, hooks: new ToolHooks(),
        inbound: new InboundCommandRouter(channel.engine, events),
        approvalMode: "auto", enabledToolEffects: ["agent_inbox", "agent_roster"],
        extensionTools: [inboxTool],
        applyToolEffect: async (effect) => {
            if (effect.type === "agent_roster") {
                slowStarted();
                await gate;
                slowSettled = true;
                return { kind: "output", output: "slow result", isError: false };
            }
            if (effect.type !== "agent_inbox") throw new Error("Unexpected effect");
            return {
                kind: "output", output: "inbox result", isError: false,
                afterCommit: { key: "inbox.acknowledge", data: { seq: 42 } },
            };
        },
        applyCommittedToolEffect: async (effect) => {
            acknowledgedEffect = effect;
            acknowledged();
        },
    };
    channel.client.send({ type: "prompt", content: "Inspect the crew" });
    const turn = runTurn(new FauxAdapter([response, final]), "test", state);
    void turn.catch(() => {});
    try {
        await Promise.race([
            Promise.all([started, ack]),
            Bun.sleep(5_000).then(() => { throw new Error("Inbox result was not acknowledged"); }),
        ]);
        expect(acknowledgedEffect).toEqual({ key: "inbox.acknowledge", data: { seq: 42 } });
        expect(slowSettled).toBe(false);
        expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect((await SessionStore.open(path)).messages().at(-1)).toMatchObject({
            role: "tool_result", toolCallId: "inbox", content: [{ type: "text", text: "inbox result" }],
        });
        release();
        await turn;
    } finally {
        release();
        await turn.catch(() => {});
        await runtime.close();
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

test("a missing committed-effect owner fails after the result is saved", async () => {
    const response: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "tool_call", id: "inbox", name: "agent_roster", input: {} },
            { type: "tool_call", id: "later", name: "agent_roster", input: {} },
        ],
        source, usage: emptyUsage(), stopReason: "tool_use",
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const writes: string[] = [];
    const runtime = new ToolRuntime(process.cwd());
    const state: RunTurnState = {
        messages: [], events, hooks: new ToolHooks(), toolRuntime: runtime,
        inbound: new InboundCommandRouter(channel.engine, events),
        approvalMode: "auto", enabledToolEffects: ["agent_roster"],
        store: {
            async appendMessage(message) {
                if (message.role === "tool_result") writes.push(message.toolCallId);
                return { id: "entry", message };
            },
        },
        applyToolEffect: async () => ({
            kind: "output", output: "inbox result", isError: false,
            afterCommit: { key: "inbox.acknowledge", data: { seq: 42 } },
        }),
    };
    channel.client.send({ type: "prompt", content: "Inspect the crew" });
    try {
        await expect(runTurn(new FauxAdapter([response]), "test", state))
            .rejects.toThrow("No owner can apply the committed tool effect");
        expect(writes).toEqual(["inbox"]);
        expect(state.messages.at(-1)).toMatchObject({ role: "tool_result", toolCallId: "inbox" });
    } finally {
        await runtime.close();
    }
});

async function runBatch(firstHeld: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vera-batch-durability-"));
    const path = join(root, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
    const response = batchResponse();
    const final: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Done" }],
        source, usage: emptyUsage(), stopReason: "stop",
    };
    const requests: ModelRequest[] = [];
    const faux = new FauxAdapter([response, final]);
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstSaved!: () => void;
    const saved = new Promise<void>((resolve) => { firstSaved = resolve; });
    store.watchRecords((_line, record) => {
        const message = record.message as { role?: string; toolCallId?: string } | undefined;
        if (message?.role === "tool_result" && message.toolCallId === "fast") firstSaved();
    });
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    let fastFinished!: () => void;
    const finished = new Promise<void>((resolve) => { fastFinished = resolve; });
    events.subscribe((event) => {
        observed.push(event);
        if (event.type === "tool_execution_finished" && event.toolCall.id === "fast") fastFinished();
    });
    const hooks = new ToolHooks();
    hooks.registerPostToolUse((payload) => payload.toolCall.id === "fast"
        ? { power: "mutate", patch: { content: [{ type: "text", text: "hooked fast result" }] } }
        : { power: "observe" });
    const runtime = new ToolRuntime(root);
    const probe: RegisteredTool = {
        parallel: true,
        permissionOperation: "agent.roster",
        definition: { name: "crow_probe", description: "Inspect the crew", inputSchema: { type: "object", properties: { slot: { type: "string" } } } },
        async execute(input) {
            const slot = input.slot;
            if (slot === (firstHeld ? "first" : "last")) await gate;
            return { kind: "output", output: `${slot} result`, isError: false };
        },
    };
    const state: RunTurnState = {
        messages: [], store, events, hooks, toolRuntime: runtime,
        inbound: new InboundCommandRouter(channel.engine, events),
        approvalMode: "auto", extensionTools: [probe],
        modelContext: () => store.modelContext(),
    };
    channel.client.send({ type: "prompt", content: "Inspect the crew" });
    const turn = runTurn(adapter, "test", state);
    void turn.catch(() => {});
    try {
        await Promise.race([
            firstHeld ? finished : saved,
            Bun.sleep(5_000).then(() => { throw new Error("Tool did not reach the expected state"); }),
        ]);
        const results = store.messages().filter((message) => message.role === "tool_result");
        if (firstHeld) {
            expect(results).toHaveLength(0);
        } else {
            expect(results.map((message) => message.toolCallId)).toEqual(["first", "fast"]);
            expect(results[1]?.content).toEqual([{ type: "text", text: "hooked fast result" }]);
            const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { message?: { role?: string; toolCallId?: string } });
            expect(records.flatMap((record) => record.message?.role === "tool_result" ? [record.message.toolCallId] : [])).toEqual(["first", "fast"]);
            const branch = await createSessionBranch({ source: store, destinationPath: join(root, "side.jsonl"), sessionId: "side", position: "at", hideInheritedMessages: true });
            const projected = transformMessages(branch.store.modelContext(), { target: source });
            const paired = projected.filter((message) => message.role === "tool_result");
            expect(paired.map((message) => message.toolCallId)).toEqual(["first", "fast", "last"]);
            expect(paired[2]).toMatchObject({ isError: true, content: [{ type: "text", text: "Tool call did not receive a result." }] });
            const wire = encodeOpenRouterMessages(undefined, projected, "test");
            expect(wire.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["first", "fast", "last"]);
        }
        expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(observed.some((event) => event.type === "tool_execution_finished" && event.toolCall.id === "fast")).toBe(true);
        release();
        await turn;
        expect(store.messages().filter((message) => message.role === "tool_result").map((message) => message.toolCallId)).toEqual(["first", "fast", "last"]);
        expect(requests).toHaveLength(2);
        const normalized = transformMessages(requests[1]!.messages, { target: source });
        return JSON.stringify(encodeOpenRouterMessages(undefined, normalized, "test"));
    } finally {
        release();
        await turn.catch(() => {});
        await runtime.close();
        await rm(root, { recursive: true, force: true });
    }
}

function batchResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [
            { type: "tool_call", id: "first", name: "crow_probe", input: { slot: "first" } },
            { type: "tool_call", id: "fast", name: "crow_probe", input: { slot: "fast" } },
            { type: "tool_call", id: "last", name: "crow_probe", input: { slot: "last" } },
        ],
        source, usage: emptyUsage(), stopReason: "tool_use",
    };
}
