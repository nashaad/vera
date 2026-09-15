import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { skillScriptTool } from "../../src/skills/script.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

async function untilFinished(client: AgentAttachment): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (true) {
        const update = await Promise.race([
            client.receive(),
            Bun.sleep(Math.max(1, deadline - Date.now())).then(() => {
                throw new Error("Timed out waiting for turn completion");
            }),
        ]);
        if (update.type === "turn_finished") return;
    }
}

test("hosted validation honors a worker's explicit invocation for only that turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-skill-invocation-"));
    const definitionPath = join(root, "meeting-reader.md");
    await writeFile(definitionPath, "---\ndescription: Read meeting notes.\ntools: [read]\n---\nRead the supplied notes without changing them.\n");
    const script: AssistantMessage[] = [];
    for (let i = 0; i < 4; i += 1) {
        script.push({
            role: "assistant",
            content: [{
                type: "tool_call", id: `check-${i}`, name: "skill_script",
                input: {
                    skill: "create-agent", script: "scripts/validate.sh",
                    args: [definitionPath],
                },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(), stopReason: "tool_use",
        }, {
            role: "assistant",
            content: [{ type: "text", text: "Check completed." }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(), stopReason: "stop",
        });
    }
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: () => ({
            module: join(import.meta.dir, "fixtures/worker-scripted-adapter.ts"),
            options: { script },
        }),
        extensionTools: [skillScriptTool],
        model: "faux/test",
        approvalMode: "full_access",
    });
    try {
        const sessionPath = join(root, "session.jsonl");
        const session = await registry.create({
            id: "skill-validation", workspace: root, sessionPath,
        });
        const client = session.attach();
        expect((await client.receive()).type).toBe("history");
        client.send({ type: "prompt", content: "Use create-agent to check the file." });
        await untilFinished(client);
        client.send({
            type: "invoke_skill", requestId: "explicit-check",
            name: "create-agent", argumentsText: "check the file",
        });
        await untilFinished(client);
        client.send({ type: "prompt", content: "Check it again." });
        await untilFinished(client);
        client.send({ type: "prompt", content: "/create-agent check the file" });
        await untilFinished(client);

        const stored = await SessionStore.open(sessionPath);
        const results = stored.messages().filter((message) =>
            message.role === "tool_result" && message.toolName === "skill_script"
        );
        expect(results).toHaveLength(4);
        expect(results[1]).toMatchObject({ isError: false });
        expect(results.map((result) => result.role === "tool_result" && result.isError))
            .toEqual([true, false, true, true]);
        expect(results[1]?.content).toEqual([{
            type: "text", text: expect.stringContaining('"name": "meeting-reader"'),
        }]);
        expect(results[2]?.content).toEqual([{
            type: "text", text: expect.stringContaining("invoke /create-agent explicitly"),
        }]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
