import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import {
    EngineEventBus,
    createJsonlEventLogger,
    type EngineEvent,
} from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";

const SOURCE = { provider: "faux", api: "scripted", model: "test" } as const;

function toolCall(
    id: string,
    name: string,
    input: Record<string, unknown>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name, input }],
        source: SOURCE,
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

const DONE: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    source: SOURCE,
    usage: emptyUsage(),
    stopReason: "stop",
};

interface Harness {
    readonly adapter: ModelAdapter;
    readonly requests: ModelRequest[];
    readonly events: EngineEvent[];
    readonly state: RunTurnState;
    readonly channel: ReturnType<typeof createInProcessChannel>;
}

async function harness(
    responses: readonly AssistantMessage[],
    approvalMode: string,
): Promise<{ harness: Harness; workspace: string }> {
    const workspace = await mkdtemp(join(tmpdir(), "vera-denial-breaker-"));
    await writeFile(join(workspace, "note.txt"), "hello\n");
    const faux = new FauxAdapter(responses);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    events.subscribe(createProtocolEncoder(channel.engine));
    events.subscribe((event) => observed.push(event));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode,
    };
    return {
        harness: { adapter, requests, events: observed, state, channel },
        workspace,
    };
}

function offeredNames(request: ModelRequest): string[] {
    return (request.tools ?? []).map((tool) => tool.name);
}

function drain(channel: ReturnType<typeof createInProcessChannel>): void {
    void (async () => {
        try {
            while (true) {
                const update = await channel.client.receive();
                if (update.type === "turn_finished") {
                    return;
                }
            }
        } catch {
            // The turn ended; nothing else is listening.
        }
    })();
}

test("a tool the policy keeps refusing stops being offered, and switching tools ends the turn", async () => {
    const { harness: h } = await harness(
        [
            toolCall("b1", "bash", { command: "echo one" }),
            toolCall("b2", "bash", { command: "echo two" }),
            toolCall("b3", "bash", { command: "echo three" }),
            toolCall("w1", "write", { path: "a.txt", content: "a" }),
            toolCall("w2", "write", { path: "b.txt", content: "b" }),
            toolCall("w3", "write", { path: "c.txt", content: "c" }),
            DONE,
        ],
        "readonly",
    );
    h.channel.client.send({ type: "prompt", content: "review the tree" });
    drain(h.channel);
    const message = await runTurn(h.adapter, "test", h.state);

    // Three refusals of bash withhold it; the fourth request no longer
    // describes it, which is the whole of what the model is told.
    expect(h.requests).toHaveLength(6);
    for (const request of h.requests.slice(0, 3)) {
        expect(offeredNames(request)).toContain("bash");
    }
    for (const request of h.requests.slice(3)) {
        expect(offeredNames(request)).not.toContain("bash");
    }

    const trips = h.events.filter(
        (event) => event.type === "tool_breaker_tripped",
    );
    expect(trips).toEqual([
        {
            type: "tool_breaker_tripped",
            tool: "bash",
            denials: 3,
            action: "withheld",
        },
        {
            type: "tool_breaker_tripped",
            tool: "write",
            denials: 3,
            action: "ended-turn",
        },
    ]);

    // The terminal outcome is typed and says what happened.
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("tool denial breaker");
    expect(message.errorMessage).toContain("write");
    // The turn stopped rather than running the model again.
    expect(h.state.messages.at(-1)).toEqual(message);
});

test("a call of a withheld tool is refused rather than run, and ends the turn", async () => {
    const { harness: h } = await harness(
        [
            toolCall("b1", "bash", { command: "echo one" }),
            toolCall("b2", "bash", { command: "echo two" }),
            toolCall("b3", "bash", { command: "echo three" }),
            toolCall("b4", "bash", { command: "echo four" }),
            DONE,
        ],
        "readonly",
    );
    h.channel.client.send({ type: "prompt", content: "go" });
    drain(h.channel);
    const message = await runTurn(h.adapter, "test", h.state);

    expect(h.requests).toHaveLength(4);
    const denials = h.events.filter((event) => event.type === "tool_denied");
    expect(denials.at(-1)).toMatchObject({ denialClass: "denial-breaker" });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("bash");
});

test("a turn denied twice and then working normally is untouched", async () => {
    const { harness: h } = await harness(
        [
            toolCall("b1", "bash", { command: "echo one" }),
            toolCall("b2", "bash", { command: "echo two" }),
            toolCall("r1", "read", { path: "note.txt" }),
            toolCall("r2", "read", { path: "note.txt" }),
            toolCall("r3", "read", { path: "note.txt" }),
            toolCall("r4", "read", { path: "note.txt" }),
            DONE,
        ],
        "readonly",
    );
    h.channel.client.send({ type: "prompt", content: "go" });
    drain(h.channel);
    const message = await runTurn(h.adapter, "test", h.state);

    expect(h.requests).toHaveLength(7);
    for (const request of h.requests) {
        expect(offeredNames(request)).toContain("bash");
    }
    expect(
        h.events.filter((event) => event.type === "tool_breaker_tripped"),
    ).toEqual([]);
    expect(message.stopReason).toBe("stop");
});

test("a long turn of allowed work never trips the breaker", async () => {
    const reads = Array.from(
        { length: 60 },
        (_unused, index) => toolCall(`r${index}`, "read", { path: "note.txt" }),
    );
    const { harness: h } = await harness([...reads, DONE], "readonly");
    h.channel.client.send({ type: "prompt", content: "go" });
    drain(h.channel);
    const message = await runTurn(h.adapter, "test", h.state);

    expect(h.requests).toHaveLength(61);
    expect(
        h.events.filter((event) => event.type === "tool_breaker_tripped"),
    ).toEqual([]);
    expect(message.stopReason).toBe("stop");
});

test("denials a person typed are not counted", async () => {
    const { harness: h } = await harness(
        [
            toolCall("b1", "bash", { command: "echo one" }),
            toolCall("b2", "bash", { command: "echo two" }),
            toolCall("b3", "bash", { command: "echo three" }),
            toolCall("b4", "bash", { command: "echo four" }),
            DONE,
        ],
        "ask",
    );
    h.channel.client.send({ type: "prompt", content: "go" });
    void (async () => {
        while (true) {
            const update = await h.channel.client.receive();
            if (update.type === "turn_finished") {
                return;
            }
            if (update.type === "ui_request") {
                h.channel.client.send({
                    type: "ui_response",
                    requestId: update.requestId,
                    response: { type: "tool_approval", decision: "deny" },
                });
            }
        }
    })();
    const message = await runTurn(h.adapter, "test", h.state);

    // Four refusals in a row, all of them a person answering. Nothing trips
    // and bash stays on the table for the whole turn.
    expect(h.requests).toHaveLength(5);
    for (const request of h.requests) {
        expect(offeredNames(request)).toContain("bash");
    }
    expect(
        h.events.filter((event) => event.type === "tool_breaker_tripped"),
    ).toEqual([]);
    expect(message.stopReason).toBe("stop");
});

test("a third refusal spread across a working turn costs only that tool", async () => {
    const reads = (count: number, from: number) =>
        Array.from(
            { length: count },
            (_unused, index) =>
                toolCall(`r${from + index}`, "read", { path: "note.txt" }),
        );
    const { harness: h } = await harness(
        [
            toolCall("b1", "bash", { command: "echo one" }),
            ...reads(10, 0),
            toolCall("b2", "bash", { command: "echo two" }),
            ...reads(10, 10),
            toolCall("b3", "bash", { command: "echo three" }),
            ...reads(10, 20),
            DONE,
        ],
        "readonly",
    );
    h.channel.client.send({ type: "prompt", content: "go" });
    drain(h.channel);
    const message = await runTurn(h.adapter, "test", h.state);

    // A tool that is refused every time it is called is withheld even when
    // other work succeeds around it, because a run of successes elsewhere is
    // what a brute-forcing turn looks like from here. The turn itself keeps
    // going: only the second trip ends one.
    expect(
        h.events.filter((event) => event.type === "tool_breaker_tripped"),
    ).toEqual([
        {
            type: "tool_breaker_tripped",
            tool: "bash",
            denials: 3,
            action: "withheld",
        },
    ]);
    expect(offeredNames(h.requests.at(-1)!)).not.toContain("bash");
    expect(offeredNames(h.requests.at(-1)!)).toContain("read");
    expect(message.stopReason).toBe("stop");
});

test("the breaker's terminal outcome survives to the real session file and log", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-denial-breaker-store-"));
    await writeFile(join(root, "note.txt"), "hello\n");
    const sessionPath = join(root, "session.jsonl");
    const logPath = join(root, "events.jsonl");
    const store = await SessionStore.create(sessionPath, {
        sessionId: "breaker-1",
        cwd: root,
    });
    const faux = new FauxAdapter([
        toolCall("b1", "bash", { command: "echo one" }),
        toolCall("b2", "bash", { command: "echo two" }),
        toolCall("b3", "bash", { command: "echo three" }),
        toolCall("w1", "write", { path: "a.txt", content: "a" }),
        toolCall("w2", "write", { path: "b.txt", content: "b" }),
        toolCall("w3", "write", { path: "c.txt", content: "c" }),
        DONE,
    ]);
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const logger = createJsonlEventLogger({
        path: logPath,
        sessionId: "breaker-1",
        level: "info",
    });
    events.subscribe(logger);
    const state: RunTurnState = {
        messages: [],
        store,
        toolRuntime: new ToolRuntime(root),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "readonly",
    };

    channel.client.send({ type: "prompt", content: "review the tree" });
    drain(channel);
    await runTurn(faux, "test", state);
    logger.flush();
    logger.close();

    // Read back from disk, not from the object that wrote it.
    const reopened = await SessionStore.open(sessionPath);
    const last = reopened.messages().at(-1);
    expect(last?.role).toBe("assistant");
    if (last?.role !== "assistant") {
        throw new Error("Expected an assistant message");
    }
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toContain("tool denial breaker");
    expect(last.errorMessage).toContain("write");

    const logged = (await readFile(logPath, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.type === "tool_breaker_tripped");
    expect(logged.map((entry) => [entry.tool, entry.action])).toEqual([
        ["bash", "withheld"],
        ["write", "ended-turn"],
    ]);
});
