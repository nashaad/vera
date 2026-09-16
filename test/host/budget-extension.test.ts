import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startResidentHost } from "../../src/host/runtime.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import type { AgentUpdate, UserQuestionUiRequestUpdate } from "../../src/engine/protocol.ts";
import { emptyUsage, type ModelRequest } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

async function until<T extends AgentUpdate["type"]>(client: AttachedAgentClient, type: T): Promise<Extract<AgentUpdate, { type: T }>> {
    const signal = AbortSignal.timeout(5000);
    while (true) {
        const update = await client.receive(signal);
        if (update.type === type) return update as Extract<AgentUpdate, { type: T }>;
    }
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "budget approval survives reconnect, supports typed increases and persistent ignore, and denial stops without spending",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-budget-host-"));
        const socketPath = join(root, "host.sock");
        const id = crypto.randomUUID();
        const requests: ModelRequest[] = [];
        const host = await startResidentHost({
            config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
            createAdapter: () => ({ stream(request) {
                requests.push(request);
                return new FauxAdapter([{ role: "assistant", content: [{ type: "text", text: "Okay." }],
                    source: { provider: "faux", api: "fixture", model: "faux/test" },
                    usage: { ...emptyUsage(), cost: 0.5 }, stopReason: "stop" }]).stream(request);
            } }),
            socketPath, lockPath: join(root, "host.json"), sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        let client: AttachedAgentClient | undefined;
        try {
            await host.registry.create({ id, workspace: root, sessionPath: join(root, "sessions", `${id}.jsonl`) });
            client = await attachAgent({ socketPath, agentId: id });
            await until(client, "history");
            await client.runExtensionCommand("budget", ".5");
            await client.send({ type: "prompt", content: "first" });
            await until(client, "turn_finished");
            expect(requests).toHaveLength(1);
            await client.send({ type: "prompt", content: "second" });
            const pending = await until(client, "ui_request") as UserQuestionUiRequestUpdate;
            expect(pending.request).toMatchObject({ customLabel: "Increase budget and continue", allowNotes: false, question: expect.stringContaining("Budget reached: $0.50 / $0.50.") });
            expect(requests).toHaveLength(1);
            client.close();
            client = await attachAgent({ socketPath, agentId: id });
            const replayed = await until(client, "ui_request");
            expect(replayed.requestId).toBe(pending.requestId);
            await client.send({ type: "ui_response", requestId: pending.requestId,
                response: { type: "user_question", outcome: "custom", text: "yes" } });
            const invalid = await until(client, "ui_request");
            expect(requests).toHaveLength(1);
            await client.send({ type: "ui_response", requestId: invalid.requestId,
                response: { type: "user_question", outcome: "custom", text: "1.5" } });
            const increased = await until(client, "turn_finished");
            expect(increased).toMatchObject({ extensionState: { "vera.budget": { dollars: 1.5 } } });
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[1]!.messages)).toContain("Budget increased to $1.50");
            await client.runExtensionCommand("budget", "1");
            await client.send({ type: "prompt", content: "ignore" });
            const ignoring = await until(client, "ui_request");
            await client.send({ type: "ui_response", requestId: ignoring.requestId,
                response: { type: "user_question", outcome: "selected", choiceId: "ignore" } });
            await until(client, "turn_finished");
            expect(requests).toHaveLength(3);
            client.close();
            client = await attachAgent({ socketPath, agentId: id });
            await until(client, "history");
            await client.send({ type: "prompt", content: "continue" });
            await until(client, "turn_finished");
            expect(requests).toHaveLength(4);
            await client.runExtensionCommand("budget", "1");
            await client.send({ type: "prompt", content: "stop" });
            const again = await until(client, "ui_request");
            await client.send({ type: "ui_response", requestId: again.requestId,
                response: { type: "user_question", outcome: "selected", choiceId: "stop" } });
            expect(await until(client, "turn_finished")).toMatchObject({ outcome: "aborted" });
            expect(requests).toHaveLength(4);
            await client.send({ type: "prompt", content: "cancel" });
            await until(client, "ui_request");
            await client.send({ type: "abort" });
            expect(await until(client, "turn_finished")).toMatchObject({ outcome: "aborted" });
            expect(requests).toHaveLength(4);
            await client.runExtensionCommand("budget", "");
            await client.send({ type: "prompt", content: "off" });
            await until(client, "turn_finished");
            expect(requests).toHaveLength(5);
        } finally {
            client?.close();
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    }, 15000,
);
