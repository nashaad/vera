import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";

test("a pre-tool hook cannot rename the call it sees", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => ({
        power: "mutate",
        // A hook that tries to change which tool runs. Only `input` is read
        // back, which is the invariant gate A's sufficiency rests on: the name
        // checked before the hooks is the name that executes.
        input: { path: "/tmp/x" },
        name: "write",
    } as never));

    const outcome = await hooks.runPreToolUse({
        type: "pre_tool_use",
        toolCall: { id: "1", name: "read", input: { path: "/tmp/y" } },
        workspace: "/tmp",
    }, { timeoutMs: 1_000 });

    expect(outcome.toolCall.name).toBe("read");
    expect(outcome.toolCall.id).toBe("1");
    expect(outcome.toolCall.input).toEqual({ path: "/tmp/x" });
});

test("a selection waits its turn in the queue rather than jumping it", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const selected: string[] = [];
    const router = new InboundCommandRouter(channel.engine, events, {
        async selectAgent(name) {
            selected.push(name);
            return { name };
        },
    });

    channel.client.send({ type: "prompt", content: "first" });
    channel.client.send({
        type: "select_agent",
        requestId: "select-1",
        name: "reviewer",
    });
    channel.client.send({ type: "prompt", content: "second" });

    // The prompt queued before the selection runs under the old agent.
    const first = await router.startTurn();
    expect(first.prompt.content).toBe("first");
    expect(selected).toEqual([]);
    router.finishTurn();

    // The selection applies where it sits, and the prompt behind it runs under it.
    const second = await router.startTurn();
    expect(selected).toEqual(["reviewer"]);
    expect(second.prompt.content).toBe("second");
    router.finishTurn();
});

test("a host with no agents refuses the selection rather than ignoring it", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events, {});

    channel.client.send({
        type: "select_agent",
        requestId: "select-1",
        name: "reviewer",
    });
    channel.client.send({ type: "prompt", content: "go" });
    const turn = await router.startTurn();
    expect(turn.prompt.content).toBe("go");
    router.finishTurn();

    expect(await channel.client.receive()).toEqual({
        type: "agent_rejected",
        requestId: "select-1",
        reason: "This host does not support agents.",
        seq: 1,
    });
});

test("an unknown agent name is named back rather than silently kept", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const router = new InboundCommandRouter(channel.engine, events, {
        async selectAgent() {
            return undefined;
        },
    });

    channel.client.send({
        type: "select_agent",
        requestId: "select-1",
        name: "nope",
    });
    channel.client.send({ type: "prompt", content: "go" });
    await router.startTurn();
    router.finishTurn();

    expect(await channel.client.receive()).toMatchObject({
        type: "agent_rejected",
        reason: "No agent named nope",
    });
});
