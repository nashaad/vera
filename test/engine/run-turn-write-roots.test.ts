import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { PermissionRule } from "../../src/engine/permissions.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core a rooted file write runs without review through the real permission path", async () => {
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
        writeRoots: [root],
        reviewToolCall: async (request) => {
            reviewed.push(String(request.toolCall.input.path));
            return {
                decision: "allow",
                reason: "The path was declared at launch.",
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
    const updates = await receiveThroughTurnFinished(channel);
    await turn;

    expect(updates.some((update) => update.type === "ui_request")).toBe(false);
    expect(reviewed).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("hello");
});

test("@core a write outside every root still goes to review", async () => {
    const workspace = temporaryDirectory();
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const target = join(outside, "notes.txt");
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
        writeRoots: [root],
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
    expect(readFileSync(target, "utf8")).toBe("hello");
});

test("@core a deny rule still wins over a declared write root", async () => {
    const workspace = temporaryDirectory();
    const root = temporaryDirectory();
    const target = join(root, "notes.txt");
    const deny: readonly PermissionRule[] = [{
        name: "permission_rules.0",
        when: { verb: "write", path: target },
        then: "deny",
    }];
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
        writeRoots: [root],
        permissionRules: deny,
        reviewToolCall: async (request) => {
            reviewed.push(String(request.toolCall.input.path));
            return {
                decision: "allow",
                reason: "Should not be reached.",
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

    expect(reviewed).toEqual([]);
    expect(existsSync(target)).toBe(false);
});

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
): Promise<Awaited<ReturnType<typeof channel.client.receive>>[]> {
    const updates: Awaited<ReturnType<typeof channel.client.receive>>[] = [];
    while (true) {
        const update = await channel.client.receive();
        updates.push(update);
        if (update.type === "turn_finished") return updates;
    }
}

function temporaryDirectory(): string {
    const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "vera-turn-write-root-")),
    );
    temporaryDirectories.push(directory);
    return directory;
}
