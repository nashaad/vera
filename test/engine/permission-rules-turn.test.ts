import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import {
    decideToolPermission,
    type PermissionRule,
} from "../../src/engine/permissions.ts";
import { createProtocolEncoder, type AgentUpdate } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import type { AssistantMessage } from "../../src/model/types.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const target = "/Users/nash/Projects/other-repo/out.txt";
const writeAsk: PermissionRule = {
    name: "permission_rules.0",
    when: { verb: "write", path: "/Users/nash/Projects/other-repo" },
    then: "ask",
};
const writeDeny: PermissionRule = { ...writeAsk, then: "deny" };

test("a rule ask in auto makes no reviewer call", async () => {
    expect(autoDecision().behavior).toBe("review");
    let reviewCalls = 0;
    const rules: readonly PermissionRule[] = [writeAsk];
    const { channel, state, turn } = permissionTurn("auto", () => rules, async () => {
        reviewCalls += 1;
        return reviewerAllow;
    });

    while (true) {
        const update = await channel.client.receive();
        if (update.type !== "ui_request") continue;
        if (update.request.type !== "tool_approval") continue;
        expect(update.request.restrictedChoices).toBe(true);
        channel.client.send({
            type: "ui_response",
            requestId: update.requestId,
            response: { type: "tool_approval", decision: "deny" },
        });
        break;
    }

    await turn;
    expect(reviewCalls).toBe(0);
});

test("a rule deny in auto makes no reviewer call", async () => {
    expect(autoDecision().behavior).toBe("review");
    let reviewCalls = 0;
    const rules: readonly PermissionRule[] = [writeDeny];
    const { channel, state, turn } = permissionTurn("auto", () => rules, async () => {
        reviewCalls += 1;
        return reviewerAllow;
    });

    const updates: AgentUpdate[] = [];
    while (true) {
        const update = await channel.client.receive();
        updates.push(update);
        if (update.type === "turn_finished") break;
    }
    await turn;

    expect(reviewCalls).toBe(0);
    expect(updates.some((update) => update.type === "ui_request")).toBe(false);
    expect(updates.map((update) => update.type)).not.toContain("tool_started");
    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        isError: true,
        withheld: true,
    });
});

test("a deny added while the reviewer decides denies that call", async () => {
    expect(autoDecision().behavior).toBe("review");
    let rules: readonly PermissionRule[] = [];
    const { channel, state, turn } = permissionTurn("auto", () => rules, async () => {
        rules = [writeDeny];
        return reviewerAllow;
    });

    const after: AgentUpdate[] = [];
    while (true) {
        const update = await channel.client.receive();
        after.push(update);
        if (update.type === "turn_finished") break;
    }
    await turn;

    expect(after.map((update) => update.type)).not.toContain("tool_started");
    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        isError: true,
        withheld: true,
    });
    expect(JSON.stringify(state.messages[2])).toContain(
        "Your permission rules require deny",
    );
});

test("a deny added while the call waits denies that call", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    let rules: readonly PermissionRule[] = [];
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "ask",
        get permissionRules() {
            return rules;
        },
    };

    channel.client.send({ type: "prompt", content: "write the file" });
    const turn = runTurn(new FauxAdapter([
        toolResponse("write", { path: target, content: "x" }),
        assistantText("done"),
    ]), "test", state);

    const before: AgentUpdate[] = [];
    while (true) {
        const update = await channel.client.receive();
        before.push(update);
        if (update.type !== "ui_request") continue;
        if (update.request.type !== "tool_approval") continue;
        rules = [{
            name: "permission_rules.0",
            when: { verb: "write", path: "/Users/nash/Projects/other-repo" },
            then: "deny",
        }];
        channel.client.send({
            type: "ui_response",
            requestId: update.requestId,
            response: { type: "tool_approval", decision: "allow_once" },
        });
        break;
    }

    const after: AgentUpdate[] = [];
    while (true) {
        const update = await channel.client.receive();
        after.push(update);
        if (update.type === "turn_finished") break;
    }
    const message = await turn;

    expect(after.map((update) => update.type)).not.toContain("tool_started");
    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        isError: true,
        withheld: true,
    });
    expect(JSON.stringify(state.messages[2])).toContain(
        "Your permission rules require deny",
    );
    expect(message.stopReason).toBe("stop");
});

function toolResponse(
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id: "call_1", name, input }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function autoDecision() {
    return decideToolPermission("auto", {
        id: "call_1",
        name: "write",
        input: { path: target, content: "x" },
    }, process.cwd());
}

const reviewerAllow = {
    decision: "allow",
    reason: "The write is ordinary.",
    riskLevel: "low",
    userAuthorization: "high",
} as const;

function permissionTurn(
    approvalMode: "ask" | "auto",
    rules: () => readonly PermissionRule[],
    review: RunTurnState["reviewToolCall"],
): {
    readonly channel: ReturnType<typeof createInProcessChannel>;
    readonly state: RunTurnState;
    readonly turn: ReturnType<typeof runTurn>;
} {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode,
        get permissionRules() {
            return rules();
        },
        ...(review === undefined ? {} : { reviewToolCall: review }),
    };
    channel.client.send({ type: "prompt", content: "write the file" });
    const turn = runTurn(new FauxAdapter([
        toolResponse("write", { path: target, content: "x" }),
        assistantText("done"),
    ]), "test", state);
    return { channel, state, turn };
}

function assistantText(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
