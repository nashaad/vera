import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePermissionRules } from "../../src/config/permission-rules.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { PermissionRule } from "../../src/engine/permissions.ts";
import { createProtocolEncoder, type AgentUpdate } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const temporaryDirectories: string[] = [];

const askOutsideReads: readonly PermissionRule[] = parsePermissionRules([
    { when: { verb: "read", path_scope: "outside_workspace" }, then: "ask" },
])!;

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core a read under a read root runs without a prompt through the real permission path", async () => {
    const workspace = temporaryDirectory();
    const root = temporaryDirectory();
    const target = join(root, "doc.md");
    writeFileSync(target, "reference text");
    const { state, run } = turnFor(workspace, target, {
        readRoots: [root],
        permissionRules: askOutsideReads,
    });

    const updates = await run();

    expect(updates.some((update) => update.type === "ui_request")).toBe(false);
    expect(toolResultText(state)).toContain("reference text");
});

test("@core a read outside every root still asks under the same rule", async () => {
    const workspace = temporaryDirectory();
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const target = join(outside, "doc.md");
    writeFileSync(target, "outside text");
    const { state, run } = turnFor(workspace, target, {
        readRoots: [root],
        permissionRules: askOutsideReads,
    }, "deny");

    const updates = await run();

    expect(updates.some((update) => update.type === "ui_request")).toBe(true);
    expect(toolResultText(state)).not.toContain("outside text");
});

test("@core a read of a denied file under a read root is withheld without a prompt", async () => {
    const workspace = temporaryDirectory();
    const root = temporaryDirectory();
    const target = join(root, "secret.txt");
    writeFileSync(target, "secret text");
    const { state, run } = turnFor(workspace, target, {
        readRoots: [root],
        permissionRules: [
            ...askOutsideReads,
            ...parsePermissionRules([{ when: { verb: "read", path: target }, then: "deny" }])!,
        ],
    });

    const updates = await run();

    expect(updates.some((update) => update.type === "ui_request")).toBe(false);
    expect(toolResultText(state)).not.toContain("secret text");
    expect(state.messages.find((message) => message.role === "tool_result")).toMatchObject({
        isError: true,
        withheld: true,
    });
});

test("a read root gives a write nothing: the write still goes to review", async () => {
    const workspace = temporaryDirectory();
    const root = temporaryDirectory();
    const target = join(root, "notes.txt");
    const reviewed: string[] = [];
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        readRoots: [root],
        reviewToolCall: async (request) => {
            reviewed.push(String(request.toolCall.input.path));
            return {
                decision: "allow",
                reason: "Writing one note is bounded.",
                riskLevel: "low",
                userAuthorization: "unknown",
            };
        },
    };

    channel.client.send({ type: "prompt", content: "write the note" });
    const turn = runTurn(adapterFor(toolResponse("write-1", "write", {
        path: target,
        content: "hello",
    })), "test", state);
    await receiveThroughTurnFinished(channel);
    await turn;

    expect(reviewed).toEqual([target]);
});

function turnFor(
    workspace: string,
    target: string,
    options: {
        readonly readRoots: readonly string[];
        readonly permissionRules: readonly PermissionRule[];
    },
    approval?: "deny",
): {
    readonly channel: ReturnType<typeof createInProcessChannel>;
    readonly state: RunTurnState;
    readonly run: () => Promise<AgentUpdate[]>;
} {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        readRoots: options.readRoots,
        permissionRules: options.permissionRules,
    };
    return {
        channel,
        state,
        run: async () => {
            channel.client.send({ type: "prompt", content: "read the file" });
            const turn = runTurn(adapterFor(toolResponse("read-1", "read", {
                path: target,
            })), "test", state);
            const updates: AgentUpdate[] = [];
            while (true) {
                const update = await channel.client.receive();
                updates.push(update);
                if (update.type === "ui_request" && approval !== undefined) {
                    channel.client.send({
                        type: "ui_response",
                        requestId: update.requestId,
                        response: { type: "tool_approval", decision: approval },
                    });
                }
                if (update.type === "turn_finished") break;
            }
            await turn;
            return updates;
        },
    };
}

function toolResultText(state: RunTurnState): string {
    return JSON.stringify(
        state.messages.filter((message) => message.role === "tool_result"),
    );
}

function adapterFor(response: AssistantMessage): ModelAdapter {
    return new FauxAdapter([
        response,
        {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ]);
}

function toolResponse(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name, input }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

async function receiveThroughTurnFinished(
    channel: ReturnType<typeof createInProcessChannel>,
): Promise<AgentUpdate[]> {
    const updates: AgentUpdate[] = [];
    while (true) {
        const update = await channel.client.receive();
        updates.push(update);
        if (update.type === "turn_finished") return updates;
    }
}

function temporaryDirectory(): string {
    const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "vera-turn-read-root-")),
    );
    temporaryDirectories.push(directory);
    return directory;
}
