import { expect, test } from "bun:test";

import { ResidentAgent } from "../../src/host/resident-agent.ts";

test("reattaching after a new turn does not replay the earlier crash facts", async () => {
    const agent = new ResidentAgent("crow", "/deck");
    agent.engine.send({
        type: "history", seq: 0, entries: [],
        unsentPrompts: [{ content: "check the sails", attachmentIds: ["image-1"] }],
    });
    const first = agent.attach();
    expect(await first.receive()).toMatchObject({ unsentPrompts: [{ content: "check the sails", attachmentIds: ["image-1"] }] });
    agent.engine.send({ type: "user_prompt", content: "continue", seq: 1 });
    const second = agent.attach();
    const replay = await second.receive();
    expect(replay.type).toBe("history");
    if (replay.type !== "history") throw new Error("missing history");
    expect(replay.unsentPrompts).toBeUndefined();
    first.detach();
    second.detach();
    agent.close();
});

test("rejected and withdrawn prompts do not leave the session busy", async () => {
    const agent = new ResidentAgent("crow", "/deck");
    const client = agent.attach();
    await client.receive();
    client.send({ type: "prompt", content: "first", requestId: "first" });
    await agent.engine.receive();
    expect(agent.idleForReplacement()).toBe(false);
    agent.engine.send({ type: "prompt_admission", requestId: "first", content: "first", status: "rejected", reason: "save failed", seq: 1 });
    expect(agent.idleForReplacement()).toBe(true);
    client.send({ type: "prompt", content: "second", requestId: "second" });
    await agent.engine.receive();
    agent.engine.send({ type: "prompt_withdrawn", requestId: "withdraw", content: "second", seq: 2 });
    expect(agent.idleForReplacement()).toBe(true);
    client.detach();
    agent.close();
});
