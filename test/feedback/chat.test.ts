import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { isToolApprovalUiRequestUpdate } from "../../src/engine/protocol.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function reply(tool: boolean): AssistantMessage {
    return {
        role: "assistant", source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(),
        stopReason: tool ? "tool_use" : "stop",
        content: tool ? [{ type: "tool_call", id: "report-1", name: "file_feedback", input: { kind: "bug", title: "Crow cannot sail", description: "Sail is stuck" } }] : [{ type: "text", text: "Report saved." }],
    };
}

for (const sessionKind of ["chat", "default"] as const) test(`${sessionKind} report from a scripted provider follows approval and reaches the store`, async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-feedback-chat-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const extensions = await startExtensionRegistry({ extensions: includedExtensionConfigs([]) });
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([reply(true), reply(false)]), model: "faux/test", approvalMode: "ask",
        registeredAgents: extensions.agents(), extensionTools: extensions.tools(),
    });
    try {
        const agent = await registry.create({ id: "crow", sessionPath: join(home, "crow.jsonl"), ...(sessionKind === "default" ? { workspace: home } : {}) });
        const client = agent.attach();
        expect((await client.receive()).type).toBe("history");
        client.send({ type: "prompt", content: "Report a bug: the sail is stuck" });
        let approvals = 0;
        while (true) {
            const update = await client.receive(AbortSignal.timeout(15000));
            if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                client.send({ type: "ui_response", requestId: update.requestId, response: { type: "tool_approval", decision: "allow_once" } });
                approvals++;
            }
            if (update.type === "turn_finished") break;
        }
        expect(approvals).toBe(1);
        const parent = join(home, "machine", "feedback");
        const names = readdirSync(parent);
        expect(names).toHaveLength(1);
        const report = JSON.parse(readFileSync(join(parent, names[0]!, "report.json"), "utf8"));
        expect(report).toMatchObject({ kind: "bug", title: "Crow cannot sail", source: "chat", session_id: "crow" });
    } finally {
        await registry.close();
        await extensions.close();
        if (previousHome === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
}, 20000);
