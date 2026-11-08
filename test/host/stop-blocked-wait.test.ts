import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachAgent } from "../../src/host/attached-client.ts";
import {
    blockSessionThroughHost,
    unblockSessionThroughHost,
} from "../../src/host/session-block-client.ts";
import { requestHostStop } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import type { StopWaitTarget } from "../../src/host/stop-when-idle.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

/**
 * A session blocked while it has queued prompts, under an open stop wait.
 * The wait must not keep listing a session the block has already stopped.
 */

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "full_access",
} as const;

const skipOnSandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
const blockedWaitTest = skipOnSandbox ? test.skip : test;

blockedWaitTest(
    "a blocked session with queued prompts does not keep an open stop wait waiting",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-blocked-wait-"));
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
                ],
                { chunkSize: 1, delayMs: 20 },
            ),
            blockedDirectory: join(root, "blocked"),
            ...paths,
        });
        const eventLog = join(paths.eventLogDirectory, "waiter.jsonl");
        const seen: StopWaitTarget[][] = [];
        let stopOutcome: unknown;
        try {
            await host.registry.create({ id: "waiter", workspace: root });
            const client = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "waiter",
            });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "start a long turn" });
            await waitFor(async () => (await countEvents(eventLog, "model_request")) === 1);
            await client.send({ type: "prompt", content: "queued behind it" });

            void requestHostStop(paths.socketPath, host.server.identity, (targets) => {
                seen.push([...targets]);
            }).then((outcome) => {
                stopOutcome = outcome;
            });

            const blocked = await blockSessionThroughHost(paths.socketPath, {
                targetAgentId: "waiter",
                sessionIds: ["waiter"],
                reason: "blocked during a stop wait",
            });
            expect(blocked).toEqual({ status: "blocked", sessionIds: ["waiter"] });
            await Bun.sleep(400);

            await waitFor(async () => stopOutcome !== undefined);
            expect(stopOutcome).toEqual({ type: "stopped" });
            expect(seen.length).toBeGreaterThan(0);
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the host");
        await Bun.sleep(25);
    }
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
