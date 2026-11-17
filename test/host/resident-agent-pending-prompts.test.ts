import { expect, test } from "bun:test";
import { AgentCommandQueueFullError, ResidentAgent } from "../../src/host/resident-agent.ts";

test("@core pending turns include accepted prompts before engine receipt", async () => {
    const agent = new ResidentAgent("crow", "/work", { maxPendingCommands: 1 });
    const client = agent.attach();
    try {
        agent.sendPrompt("Find the map.");
        expect(agent.hasPendingTurn()).toBe(true);
        expect(() => agent.sendPrompt("Find the ship.")).toThrow(AgentCommandQueueFullError);
        expect(await agent.engine.receive()).toMatchObject({ type: "prompt", content: "Find the map." });
        expect(agent.hasPendingTurn()).toBe(true);
        agent.engine.send({ type: "user_prompt", content: "Find the map.", seq: 1 });
        agent.engine.send({ type: "turn_finished", seq: 2 });
        expect(agent.hasPendingTurn()).toBe(false);

        client.send({ type: "get_model_settings", requestId: "settings" });
        expect(agent.hasPendingTurn()).toBe(false);
        expect((await agent.engine.receive()).type).toBe("get_model_settings");
        client.send({ type: "prompt", content: "Inspect the mast." });
        expect(agent.hasPendingTurn()).toBe(true);
        expect((await agent.engine.receive()).type).toBe("prompt");
        agent.engine.send({ type: "user_prompt", content: "Inspect the mast.", seq: 3 });
        agent.engine.send({ type: "turn_finished", seq: 4 });
        expect(agent.hasPendingTurn()).toBe(false);

        agent.noteRouterHalted(false);
        agent.sendPrompt("Dropped while halted.");
        expect(agent.hasPendingTurn()).toBe(false);
        expect((await agent.engine.receive()).type).toBe("prompt");
        agent.noteRouterCleared();
        expect(agent.hasPendingTurn()).toBe(false);
    } finally {
        client.detach();
        agent.close();
    }
});
