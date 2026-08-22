import { expect, test } from "bun:test";

import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { parseAgentUpdate } from "../../src/host/agent-update-wire.ts";

test("a checkpoint taken mid-turn replays the status the turn is in", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const opening = agent.attach();
    await opening.receive();

    agent.engine.send({ type: "user_prompt", content: "run it", seq: 1 });
    agent.engine.send({
        type: "history",
        entries: [{ kind: "user", text: "run it" }],
        seq: 1,
    });
    expect(agent.status).toBe("working");

    try {
        const joined = agent.attach();
        expect(await joined.receive()).toMatchObject({
            type: "history",
            status: "working",
        });
        joined.detach();
    } finally {
        opening.detach();
        agent.close();
    }
});

test("a live checkpoint carries no status, only the replayed one does", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const opening = agent.attach();
    await opening.receive();

    agent.engine.send({ type: "user_prompt", content: "run it", seq: 1 });
    expect(await opening.receive()).toMatchObject({ type: "user_prompt" });
    agent.engine.send({
        type: "history",
        entries: [{ kind: "user", text: "run it" }],
        seq: 1,
    });

    try {
        const live = await opening.receive();
        expect(live).toMatchObject({ type: "history" });
        expect((live as { status?: string }).status).toBeUndefined();
    } finally {
        opening.detach();
        agent.close();
    }
});

test("a checkpoint from a finished turn replays without a status", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const opening = agent.attach();
    await opening.receive();

    agent.engine.send({ type: "user_prompt", content: "run it", seq: 1 });
    agent.engine.send({ type: "turn_finished", seq: 2 });
    agent.engine.send({
        type: "history",
        entries: [{ kind: "user", text: "run it" }],
        seq: 2,
    });

    try {
        const joined = agent.attach();
        const checkpoint = await joined.receive();
        expect((checkpoint as { status?: string }).status).toBeUndefined();
        joined.detach();
    } finally {
        opening.detach();
        agent.close();
    }
});

test("a waiting checkpoint survives the wire, a bad status does not", () => {
    expect(parseAgentUpdate({
        type: "history",
        entries: [],
        seq: 3,
        status: "waiting",
    })).toMatchObject({ status: "waiting" });
    expect(parseAgentUpdate({
        type: "history",
        entries: [],
        seq: 3,
        status: "busy",
    })).toBeUndefined();
});

test("a turn that finished after the checkpoint replays as idle, not stale", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const opening = agent.attach();
    await opening.receive();

    agent.engine.send({ type: "user_prompt", content: "run it", seq: 1 });
    agent.engine.send({
        type: "history",
        entries: [{ kind: "user", text: "run it" }],
        seq: 1,
    });
    agent.engine.send({ type: "turn_finished", seq: 2 });
    expect(agent.status).toBe("idle");

    try {
        const joined = agent.attach();
        const checkpoint = await joined.receive();
        expect((checkpoint as { status?: string }).status).toBeUndefined();
        joined.detach();
    } finally {
        opening.detach();
        agent.close();
    }
});
