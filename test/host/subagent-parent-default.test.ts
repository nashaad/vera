import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { subagentPoolPolicy } from "../../src/host/subagent-policy.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "openrouter", api: "scripted", model: "parent" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

test("@core an ordinary child runs on the parent model with no subagent settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-parent-default-"));
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
        schema_version: 1, provider: "openrouter", model: "parent", approval_mode: "auto",
    }));
    const requests: string[] = [];
    let adapters = 0;
    const registry = new AgentRegistry({
        createAdapter() {
            adapters += 1;
            const responses: AssistantMessage[] = adapters === 1
                ? [{
                    role: "assistant",
                    content: [{ type: "tool_call", id: "spawn", name: "subagent", input: { description: "do the work" } }],
                    source: { provider: "openrouter", api: "scripted", model: "parent" },
                    usage: emptyUsage(),
                    stopReason: "tool_use",
                }, response("parent finished")]
                : [response("child finished")];
            const adapter = new FauxAdapter(responses);
            return {
                stream(request) {
                    requests.push(request.model);
                    return adapter.stream(request);
                },
            };
        },
        provider: "openrouter",
        model: "parent",
        approvalMode: "auto",
        readPool: () => [],
        readPolicy: () => subagentPoolPolicy({ userPath: join(root, "pool.json"), configPath }),
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
    });
    try {
        const parent = await registry.create({ id: "parent", workspace: root, sessionPath: join(root, "parent.jsonl") });
        const attachment = parent.attach();
        attachment.send({ type: "prompt", content: "delegate" });
        const signal = AbortSignal.timeout(10_000);
        for (;;) {
            const update = await attachment.receive(signal);
            if (update.type === "agent_failed") throw new Error(update.detail);
            if (update.type === "ui_request" && update.request.type === "configuration_required") {
                throw new Error("The parent model should not require subagent setup");
            }
            if (update.type === "turn_finished") break;
        }
        expect(requests).toEqual(["parent", "parent", "parent"]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
}, 15_000);
