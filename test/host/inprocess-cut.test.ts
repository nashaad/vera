import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

/**
 * A cut through the in-process registry stops the running turn and drops its
 * queued prompts. The session is not left halted, so the next prompt starts.
 */

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "full_access",
} as const;

socketTest(
    "a cut stops an in-process turn, drops its queued prompts, and the next prompt starts",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-inproc-cut-"));
        const paths = {
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "events"),
        };
        const host = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter(
                [
                    textResponse("x".repeat(600)),
                    textResponse("queued prompt must not run"),
                    textResponse("prompt after the cut"),
                ],
                { chunkSize: 1, delayMs: 20 },
            ),
            blockedDirectory: join(root, "blocked"),
            ...paths,
        });
        const eventLog = join(paths.eventLogDirectory, "cutter.jsonl");
        try {
            await host.registry.create({ id: "cutter", workspace: root });
            const client = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "cutter",
            });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "start a long turn" });
            await waitFor(async () => (await countEvents(eventLog, "model_request")) === 1);
            await client.send({ type: "prompt", content: "queued behind it" });

            expect(await host.registry.cutSessionForStop("cutter", "Vera is stopping")).toBe(true);

            await waitFor(async () => !(await isWorking(paths.socketPath, "cutter")));
            await Bun.sleep(400);
            expect(await countEvents(eventLog, "model_request")).toBe(1);

            await client.send({ type: "prompt", content: "after the cut" });
            await waitFor(async () => (await countEvents(eventLog, "model_request")) === 2);
            await client.close();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    20_000,
);

socketTest("a cut on a session that is not in the host reports false", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-inproc-cut-missing-"));
    const host = await startResidentHost({
        config,
        createAdapter: () => new FauxAdapter([], { chunkSize: 1, delayMs: 0 }),
        blockedDirectory: join(root, "blocked"),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "events"),
    });
    try {
        expect(await host.registry.cutSessionForStop("nobody", "Vera is stopping")).toBe(false);
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

function textResponse(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "faux/test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the host");
        await Bun.sleep(25);
    }
}

async function isWorking(socketPath: string, id: string): Promise<boolean> {
    return (await listAgentsThroughHost(socketPath)).some((agent) =>
        agent.id === id && agent.status === "working"
    );
}

async function countEvents(path: string, type: string): Promise<number> {
    let contents: string;
    try {
        contents = await readFile(path, "utf8");
    } catch {
        return 0;
    }
    return contents.split("\n").filter((line) => line.includes(`"type":"${type}"`)).length;
}
