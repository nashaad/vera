import { expect, test } from "bun:test";

import {
    AgentCommandQueueFullError,
    AgentDetachedError,
    ResidentAgent,
    ResidentAgentClosedError,
} from "../../src/host/resident-agent.ts";
import type { HistoryUpdate } from "../../src/engine/protocol.ts";

test("resident agent replays a checkpoint and every later update", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach();

    expect(await first.receive()).toEqual({
        type: "history",
        entries: [],
        seq: 0,
    });

    first.send({ type: "prompt", content: "hello" });
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "hello",
    });
    agent.engine.send({ type: "user_prompt", content: "hello", seq: 1 });
    agent.engine.send({ type: "assistant_delta", text: "hello", seq: 2 });

    expect(await first.receive()).toEqual({
        type: "user_prompt",
        content: "hello",
        seq: 1,
    });
    expect(await first.receive()).toEqual({
        type: "assistant_delta",
        text: "hello",
        seq: 2,
    });

    const second = agent.attach();
    expect(await second.receive()).toEqual({
        type: "history",
        entries: [],
        seq: 0,
    });
    expect(await second.receive()).toEqual({
        type: "user_prompt",
        content: "hello",
        seq: 1,
    });
    expect(await second.receive()).toEqual({
        type: "assistant_delta",
        text: "hello",
        seq: 2,
    });

    const checkpoint: HistoryUpdate = {
        type: "history",
        entries: [
            { kind: "user", text: "hello" },
            { kind: "assistant", text: "hello" },
        ],
        seq: 2,
    };
    agent.engine.send(checkpoint);
    expect(await first.receive()).toEqual(checkpoint);
    expect(await second.receive()).toEqual(checkpoint);

    const third = agent.attach();
    expect(await third.receive()).toEqual(checkpoint);
    agent.engine.send({ type: "turn_finished", seq: 3 });
    expect(await first.receive()).toEqual({ type: "turn_finished", seq: 3 });
    expect(await second.receive()).toEqual({ type: "turn_finished", seq: 3 });
    expect(await third.receive()).toEqual({ type: "turn_finished", seq: 3 });
});

test("resident agent bounds commands waiting for the engine", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one", {
        maxPendingCommands: 1,
    });
    const client = agent.attach();
    await client.receive();

    client.send({ type: "prompt", content: "first" });
    expect(() => client.send({ type: "prompt", content: "second" }))
        .toThrow(AgentCommandQueueFullError);
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "first",
    });
    client.send({ type: "prompt", content: "after drain" });
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "after drain",
    });
});

test("detaching one client leaves the resident agent and peers alive", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach();
    const second = agent.attach();
    await first.receive();
    await second.receive();

    first.detach();
    first.detach();
    expect(() => first.send({ type: "abort" })).toThrow(AgentDetachedError);
    await expect(first.receive()).rejects.toBeInstanceOf(AgentDetachedError);

    second.send({ type: "prompt", content: "still here" });
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "still here",
    });
    agent.engine.send({ type: "turn_finished", seq: 1 });
    expect(await second.receive()).toEqual({ type: "turn_finished", seq: 1 });
});

test("closing a resident agent discards buffered commands and updates", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const client = agent.attach();
    await client.receive();
    client.send({ type: "prompt", content: "do not run" });
    agent.engine.send({ type: "assistant_delta", text: "stale", seq: 1 });

    agent.close();
    agent.close();

    await expect(agent.engine.receive()).rejects.toBeInstanceOf(
        ResidentAgentClosedError,
    );
    await expect(client.receive()).rejects.toBeInstanceOf(
        ResidentAgentClosedError,
    );
    expect(() => agent.attach()).toThrow(ResidentAgentClosedError);
});

test("resident agent snapshots commands and isolates attached clients", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach();
    const second = agent.attach();
    await first.receive();
    await second.receive();

    const command = { type: "prompt" as const, content: "original" };
    first.send(command);
    command.content = "changed";
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "original",
    });

    const update = {
        type: "tool_started" as const,
        tool: "write",
        args: { nested: { value: "original" } },
        seq: 1,
    };
    agent.engine.send(update);
    update.args.nested.value = "changed outside";
    const firstUpdate = await first.receive();
    if (firstUpdate.type !== "tool_started") {
        throw new Error("Expected tool update");
    }
    (firstUpdate.args.nested as { value: string }).value = "changed by client";
    expect(await second.receive()).toEqual({
        type: "tool_started",
        tool: "write",
        args: { nested: { value: "original" } },
        seq: 1,
    });

    const later = agent.attach();
    await later.receive();
    expect(await later.receive()).toEqual({
        type: "tool_started",
        tool: "write",
        args: { nested: { value: "original" } },
        seq: 1,
    });
});
