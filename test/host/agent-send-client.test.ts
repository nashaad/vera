import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendPromptThroughHost } from "../../src/host/agent-send-client.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "one-shot send prints one resident turn and detaches",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-send-client-"));
        const agent = new ResidentAgent("agent-1", "/work/one");
        const server = await startHostServer({
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            findAgent: () => agent,
        });
        const run = respondToPrompt(agent);
        try {
            expect(await sendPromptThroughHost(
                server.socketPath,
                agent.id,
                "check the tests",
            )).toBe("The tests pass.");
            await run;
            expect(agent.closed).toBe(false);
        } finally {
            agent.close();
            await server.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

async function respondToPrompt(agent: ResidentAgent): Promise<void> {
    expect(await agent.engine.receive()).toEqual({
        type: "prompt",
        content: "check the tests",
    });
    agent.engine.send({
        type: "user_prompt",
        content: "check the tests",
        seq: 1,
    });
    agent.engine.send({ type: "assistant_delta", text: "The tests ", seq: 2 });
    agent.engine.send({ type: "assistant_delta", text: "pass.", seq: 3 });
    agent.engine.send({ type: "turn_finished", seq: 4 });
}
