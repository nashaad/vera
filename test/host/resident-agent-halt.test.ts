import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";

const SETTLE_MS = 20;

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function harness(): { readonly agent: ResidentAgent; readonly router: InboundCommandRouter } {
    const agent = new ResidentAgent("agent-halt", "/work/halt");
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(agent.engine));
    const router = new InboundCommandRouter(agent.engine, events);
    return { agent, router };
}

test("a cut that drops a queued prompt leaves the session idle once the turn ends", async () => {
    const { agent, router } = harness();
    agent.sendPrompt("first");
    const turn = router.startTurn();
    await turn;
    await settle();
    agent.engine.send({ type: "user_prompt", content: "first", seq: 1 });
    agent.sendPrompt("second");
    await settle();
    expect(agent.idleForReplacement()).toBe(false);

    router.halt("stopped for test");
    agent.noteRouterHalted(false);
    agent.engine.send({ type: "turn_finished", seq: 3 });
    await settle();

    expect(agent.idleForReplacement()).toBe(true);
});

test("a prompt that arrives during the halt is not counted as outstanding", async () => {
    const { agent, router } = harness();
    router.halt("stopped for test");
    agent.noteRouterHalted(false);

    agent.sendPrompt("during the halt");
    await settle();

    expect(agent.idleForReplacement()).toBe(true);
});

test("clearing the halt counts prompts again", async () => {
    const { agent, router } = harness();
    router.halt("stopped for test");
    agent.noteRouterHalted(false);
    router.clearHalt();
    agent.noteRouterCleared();

    agent.sendPrompt("after the halt");
    await settle();

    expect(agent.idleForReplacement()).toBe(false);
});

test("a worker cut releases the counts when the cut turn finishes", async () => {
    const agent = new ResidentAgent("agent-worker", "/work/worker");
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(agent.engine));
    agent.noteRouterHalted(true);
    const whileHalted = agent.engine.receive();
    agent.sendPrompt("while the worker is halted");
    expect((await whileHalted).type).toBe("prompt");
    expect(agent.idleForReplacement()).toBe(true);

    agent.engine.send({ type: "turn_finished", seq: 1 });
    const afterRelease = agent.engine.receive();
    agent.sendPrompt("after the worker releases");
    expect((await afterRelease).type).toBe("prompt");

    expect(agent.idleForReplacement()).toBe(false);
});
