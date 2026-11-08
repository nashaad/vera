import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import {
    blockSessionThroughHost,
    unblockSessionThroughHost,
} from "../../src/host/session-block-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

/**
 * createAdapter keeps the session in the host process, which is the path that
 * has no worker. The block must stop its turn and drop its queue all the same.
 */

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "full_access",
} as const;

const skipOnSandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
const inProcessTest = skipOnSandbox ? test.skip : test;

inProcessTest(
    "a block stops an in-process turn, drops its queued prompts, and unblock lets a new turn start",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-inproc-block-"));
        const paths = {
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "events"),
        };
        const blockedDirectory = join(root, "blocked");
        const host = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter(
                [
                    textResponse("x".repeat(600)),
                    textResponse("queued prompt must not run"),
                    textResponse("prompt after unblock"),
                ],
                { chunkSize: 1, delayMs: 20 },
            ),
            blockedDirectory,
            ...paths,
        });
        const eventLog = join(paths.eventLogDirectory, "stepper.jsonl");
        try {
            await host.registry.create({ id: "stepper", workspace: root });
            const client = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "stepper",
            });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "start a long turn" });
            await waitFor(async () => (await countEvents(eventLog, "model_request")) === 1);
            await client.send({ type: "prompt", content: "queued behind it" });

            const blocked = await blockSessionThroughHost(paths.socketPath, {
                targetAgentId: "stepper",
                sessionIds: ["stepper"],
                reason: "in-process test",
            });
            expect(blocked).toEqual({ status: "blocked", sessionIds: ["stepper"] });

            await waitFor(async () => !(await isWorking(paths.socketPath, "stepper")));
            await Bun.sleep(400);
            expect(await countEvents(eventLog, "model_request")).toBe(1);

            const unblocked = await unblockSessionThroughHost(paths.socketPath, {
                targetAgentId: "stepper",
                sessionIds: ["stepper"],
            });
            expect(unblocked).toEqual({
                status: "unblocked",
                sessionIds: ["stepper"],
            });

            await client.send({ type: "prompt", content: "after unblock" });
            await waitFor(async () => (await countEvents(eventLog, "model_request")) === 2);
            await client.close();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    20_000,
);

function textResponse(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "faux/test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
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
    return contents
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { type: string }).type)
        .filter((eventType) => eventType === type).length;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (await predicate()) return;
        await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for in-process session state");
}
