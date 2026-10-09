import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { foldUsageSessionDetail } from "../../src/annex/usage-report.ts";
import type { VeraConfig } from "../../src/config.ts";
import { modelRequestSnapshotPath } from "../../src/engine/events.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { createExtensionHostServices } from "../../src/host/extension-host-services.ts";
import { readModelRequestSnapshot } from "../../src/model-request-inspector.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelRequest,
    type ModelUsage,
} from "../../src/model/types.ts";
import type { ModelEventStream } from "../../src/model/stream.ts";
import type { ModelAdapterContext } from "../../src/sdk/model-middleware.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const config = {
    model_assignments: {
        snappy: {
            models: [
                { name: "parrot", provider: "rookery", model: "parrot-1" },
                { name: "crow", provider: "rookery", model: "crow-mini" },
            ],
        },
    },
} as unknown as VeraConfig;

const unusedRegistry = {} as AgentRegistry;

test("a oneshot answers from the slot's first reachable model", async () => {
    const requests: ModelRequest[] = [];
    const services = createExtensionHostServices({
        registry: unusedRegistry,
        currentConfig: () => config,
        reachability: () => (model) => model.model !== "parrot-1",
        createAdapter: () => recording(
            new FauxAdapter([reply("Raid on the button factory")]),
            requests,
        ),
    });

    const result = await services.oneshot({
        assignment: "snappy",
        systemPrompt: "Name this voyage.",
        messages: [{ role: "user", text: "plot a course for the shiny buttons" }],
        maxTokens: 32,
    }, new AbortController().signal);

    expect(result).toEqual({
        text: "Raid on the button factory",
        model: "crow-mini",
        provider: "rookery",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
        provider: "rookery",
        model: "crow-mini",
        maxTokens: 32,
        systemPrompt: "Name this voyage.",
    });
});

test("a oneshot refuses an empty slot instead of using a session model", async () => {
    let adapters = 0;
    const services = createExtensionHostServices({
        registry: unusedRegistry,
        currentConfig: () => config,
        reachability: () => () => true,
        createAdapter: () => {
            adapters += 1;
            return new FauxAdapter([]);
        },
    });

    await expect(services.oneshot({
        assignment: "extra",
        systemPrompt: "",
        messages: [{ role: "user", text: "caw" }],
    }, new AbortController().signal)).rejects.toThrow(
        "No reachable model is assigned to extra",
    );
    expect(adapters).toBe(0);
});

test("a cancelled oneshot rejects and the next one still answers", async () => {
    const services = createExtensionHostServices({
        registry: unusedRegistry,
        currentConfig: () => config,
        reachability: () => () => true,
        createAdapter: () => new FauxAdapter([reply("Sails trimmed.")], { delayMs: 50 }),
    });
    const message = { role: "user" as const, text: "trim the sails" };

    const controller = new AbortController();
    const pending = services.oneshot(
        { assignment: "snappy", systemPrompt: "", messages: [message] },
        controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();

    const next = await services.oneshot(
        { assignment: "snappy", systemPrompt: "", messages: [message] },
        new AbortController().signal,
    );
    expect(next.text).toBe("Sails trimmed.");
});

test("an ask replays the last request with one question and only bills the session", async () => {
    const voyage = await openVoyage([
        { message: reply("The buttons are buried under the lighthouse.", usage(1200, 40)) },
        { message: reply("Three shiny buttons, captain.", usage(1260, 12, 0.002)) },
    ]);
    try {
        await runPrompt(voyage.attachment, "Where are the shiny buttons?");
        const snapshotPath = modelRequestSnapshotPath(voyage.eventLogPath);
        const snapshotBefore = await readFile(snapshotPath, "utf8");
        const sessionBefore = await readFile(voyage.sessionPath, "utf8");
        const messagesBefore = (await SessionStore.open(voyage.sessionPath)).messages();
        const saved = await readModelRequestSnapshot(voyage.eventLogPath, "crow");

        const result = await voyage.services.askSession(
            { sessionId: "crow", question: "How many buttons did we find?" },
            new AbortController().signal,
        );

        expect(voyage.requests).toHaveLength(2);
        const [turn, asked] = voyage.requests as [ModelRequest, ModelRequest];
        expect(result).toEqual({
            text: "Three shiny buttons, captain.",
            model: turn.model,
            provider: turn.provider!,
        });
        expect(saved?.provider).toBe(turn.provider!);
        expect(asked).toMatchObject({ provider: turn.provider!, model: turn.model, maxTokens: turn.maxTokens });
        expect(asked.systemPrompt).toBe(saved!.systemPrompt);
        expect(asked.tools).toEqual(saved!.tools);
        expect(asked.tools!.length).toBeGreaterThan(0);
        expect(asked.messages).toEqual([
            ...saved!.messages,
            { role: "user", content: [{ type: "text", text: "How many buttons did we find?" }] },
        ]);
        expect(voyage.contexts.map((context) => context.purpose)).toEqual(["turn", "ask"]);
        expect(voyage.contexts[1]!.ask).toBeUndefined();

        expect(await readFile(snapshotPath, "utf8")).toBe(snapshotBefore);
        const sessionAfter = await readFile(voyage.sessionPath, "utf8");
        expect(sessionAfter.startsWith(sessionBefore)).toBe(true);
        const added = sessionAfter.slice(sessionBefore.length).trim().split("\n");
        expect(added).toHaveLength(1);
        expect(JSON.parse(added[0]!)).toMatchObject({
            type: "session_ask",
            billed: { provider: turn.provider!, model: turn.model, usage: { inputTokens: 1260, outputTokens: 12 } },
        });
        const reopened = await SessionStore.open(voyage.sessionPath);
        expect(reopened.messages()).toEqual(messagesBefore);

        const detail = await foldUsageSessionDetail({
            sessionDirectory: voyage.sessionDirectory,
            window: "all",
            sessionId: "crow",
            catalogCacheDir: voyage.catalogDirectory,
        });
        const asks = detail!.calls.filter((call) => call.kind === "ask");
        expect(asks).toHaveLength(1);
        expect(asks[0]).toMatchObject({
            provider: turn.provider!,
            model: turn.model,
            inputTokens: 1260,
            outputTokens: 12,
            cost: 0.002,
            costKind: "reported",
        });
        expect(detail!.calls.filter((call) => call.kind === "turn")).toHaveLength(1);
    } finally {
        await voyage.close();
    }
});

test("an ask that gets a tool call back rejects and runs nothing", async () => {
    const voyage = await openVoyage([
        { message: reply("Anchored.", usage(900, 5)) },
        { message: toolCall("bash", { command: "touch mutiny" }, usage(950, 20)) },
    ]);
    try {
        await runPrompt(voyage.attachment, "Drop anchor.");
        const messagesBefore = (await SessionStore.open(voyage.sessionPath)).messages();

        await expect(voyage.services.askSession(
            { sessionId: "crow", question: "Is the hold dry?" },
            new AbortController().signal,
        )).rejects.toThrow("tool call instead of text");

        const reopened = await SessionStore.open(voyage.sessionPath);
        expect(reopened.messages()).toEqual(messagesBefore);
        expect(await Bun.file(join(voyage.workspace, "mutiny")).exists()).toBe(false);
        expect(reopened.usageMessages().filter((message) => message.source.api === "ask"))
            .toHaveLength(1);
    } finally {
        await voyage.close();
    }
});

test("an unreachable session model rejects by name and never falls back", async () => {
    const voyage = await openVoyage([
        { message: reply("Charted.", usage(800, 4)) },
        { message: failure("connection refused") },
    ]);
    try {
        await runPrompt(voyage.attachment, "Chart the reef.");
        const sessionBefore = await readFile(voyage.sessionPath, "utf8");
        const turn = voyage.requests[0]!;

        await expect(voyage.services.askSession(
            { sessionId: "crow", question: "Any sharks?" },
            new AbortController().signal,
        )).rejects.toThrow(`${turn.provider}/${turn.model} could not answer: connection refused`);

        expect(voyage.requests).toHaveLength(2);
        expect(voyage.requests[1]).toMatchObject({ provider: turn.provider!, model: turn.model });
        expect(await readFile(voyage.sessionPath, "utf8")).toBe(sessionBefore);
    } finally {
        await voyage.close();
    }
});

test("an ask whose provider cannot be built names the model", async () => {
    let builds = 0;
    const voyage = await openVoyage([{ message: reply("Docked.", usage(600, 2)) }], () => {
        builds += 1;
        if (builds > 1) throw new Error("no credentials for this route");
    });
    try {
        await runPrompt(voyage.attachment, "Dock the ship.");
        const turn = voyage.requests[0]!;
        await expect(voyage.services.askSession(
            { sessionId: "crow", question: "Who has the keys?" },
            new AbortController().signal,
        )).rejects.toThrow(`${turn.provider}/${turn.model} could not answer: no credentials for this route`);
        expect(voyage.requests).toHaveLength(1);
    } finally {
        await voyage.close();
    }
});

test("an ask needs an open session that has sent a request", async () => {
    const voyage = await openVoyage([]);
    try {
        const signal = new AbortController().signal;
        await expect(voyage.services.askSession({ sessionId: "parrot", question: "caw" }, signal))
            .rejects.toThrow("Session parrot is not open");
        await expect(voyage.services.askSession({ sessionId: "crow", question: "caw" }, signal))
            .rejects.toThrow("has not sent a model request yet");
        expect(voyage.requests).toHaveLength(0);
    } finally {
        await voyage.close();
    }
});

test("an ask answers while the session's own turn is still running", async () => {
    const voyage = await openVoyage([
        { message: reply("Hoisted.", usage(700, 3)) },
        { message: reply("Still rowing.", usage(720, 3)), delayMs: 400 },
        { message: reply("Two oars in the water.", usage(730, 6)) },
    ]);
    try {
        await runPrompt(voyage.attachment, "Hoist the flag.");
        voyage.attachment.send({ type: "prompt", content: "Row to the island." });
        await waitFor(() => voyage.requests.length === 2);

        const answer = await voyage.services.askSession(
            { sessionId: "crow", question: "How many oars?" },
            new AbortController().signal,
        );
        expect(answer.text).toBe("Two oars in the water.");
        await receiveTurnFinished(voyage.attachment);
    } finally {
        await voyage.close();
    }
});

interface ScriptedReply {
    readonly message: AssistantMessage;
    readonly delayMs?: number;
}

async function openVoyage(script: ScriptedReply[], onBuild: () => void = () => {}) {
    const root = await mkdtemp(join(tmpdir(), "vera-session-ask-"));
    const workspace = join(root, "workspace");
    const sessionDirectory = join(root, "sessions");
    const catalogDirectory = join(root, "catalog");
    const logDirectory = join(root, "logs");
    await Promise.all([workspace, sessionDirectory, catalogDirectory, logDirectory]
        .map((directory) => mkdir(directory, { recursive: true })));
    const sessionPath = join(sessionDirectory, "crow.jsonl");
    const eventLogPath = join(logDirectory, "crow.jsonl");
    const requests: ModelRequest[] = [];
    const contexts: ModelAdapterContext[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => {
            onBuild();
            return {
                stream(request: ModelRequest): ModelEventStream {
                    requests.push(request);
                    const next = script.shift();
                    return new FauxAdapter(next === undefined ? [] : [next.message], {
                        ...(next?.delayMs === undefined ? {} : { delayMs: next.delayMs }),
                    }).stream(request);
                },
            };
        },
        modelMiddleware: [(adapter, context) => {
            contexts.push(context);
            return adapter;
        }],
        model: "faux/test",
        approvalMode: "auto",
    });
    const agent = await registry.create({ id: "crow", workspace, sessionPath, eventLogPath });
    const attachment = agent.attach();
    expect((await attachment.receive()).type).toBe("history");
    const services = createExtensionHostServices({
        registry,
        currentConfig: () => config,
        reachability: () => () => true,
        createAdapter: () => new FauxAdapter([]),
    });
    return {
        root, workspace, sessionDirectory, catalogDirectory, sessionPath, eventLogPath,
        requests, contexts, attachment, services,
        async close() {
            await registry.close();
            await rm(root, { recursive: true, force: true });
        },
    };
}

async function runPrompt(attachment: AgentAttachment, content: string): Promise<void> {
    attachment.send({ type: "prompt", content });
    await receiveTurnFinished(attachment);
}

async function receiveTurnFinished(attachment: AgentAttachment): Promise<void> {
    while ((await attachment.receive()).type !== "turn_finished") {
        // Drain the turn's updates up to its boundary.
    }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("condition did not hold in time");
        await Bun.sleep(5);
    }
}

function usage(inputTokens: number, outputTokens: number, cost?: number): ModelUsage {
    return {
        ...emptyUsage(),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cost === undefined ? {} : { cost }),
    };
}

function toolCall(name: string, input: Record<string, unknown>, spent: ModelUsage): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name, input }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: spent,
        stopReason: "tool_use",
    };
}

function failure(errorMessage: string): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage,
    };
}

function recording(adapter: FauxAdapter, requests: ModelRequest[]) {
    return {
        stream(request: ModelRequest): ModelEventStream {
            requests.push(request);
            return adapter.stream(request);
        },
    };
}

function reply(text: string, spent: ModelUsage = emptyUsage()): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: spent,
        stopReason: "stop",
    };
}
