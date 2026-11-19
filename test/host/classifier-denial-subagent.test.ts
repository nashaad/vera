import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { isToolApprovalUiRequestUpdate, type AgentUpdate } from "../../src/engine/protocol.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const adapterModule = fileURLToPath(new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url));
const source = { provider: "faux", api: "scripted", model: "test" } as const;
const denial = JSON.stringify({
    risk_level: "high",
    user_authorization: "unknown",
    outcome: "deny",
    rationale: "The crow did not authorize this action.",
});

function text(value: string): AssistantMessage {
    return { role: "assistant", content: [{ type: "text", text: value }], source, usage: emptyUsage(), stopReason: "stop" };
}

function call(id: string, name: string, input: Record<string, unknown>): AssistantMessage {
    return { role: "assistant", content: [{ type: "tool_call", id, name, input }], source, usage: emptyUsage(), stopReason: "tool_use" };
}

async function receiveUntil(attachment: AgentAttachment, wanted: (update: AgentUpdate) => boolean): Promise<AgentUpdate> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const update = await Promise.race([
            attachment.receive(),
            Bun.sleep(deadline - Date.now()).then(() => { throw new Error("Timed out waiting for agent update"); }),
        ]);
        if (wanted(update)) return update;
    }
    throw new Error("Timed out waiting for agent update");
}

async function expectWorkerExit(pid: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { return; }
        await Bun.sleep(20);
    }
    throw new Error(`Worker ${pid} did not exit`);
}

for (const worker of [false, true]) {
    for (const asyncChild of [false, true]) {
        for (const answer of ["allow_once", "deny"] as const) {
            test(`@core ${worker ? "worker" : "in-process"} ${asyncChild ? "async" : "sync"} subagent relays classifier denial ${answer}`, async () => {
                const root = await mkdtemp(join(tmpdir(), "vera-denial-child-"));
                const outside = `${root}-outside`;
                const childTask = "Write the crow marker";
                const write = call("write-crow", "bash", { command: `printf crow > '${outside}'` });
                const childScript = [write, text(denial), text("Child finished.")];
                const spawn = call("spawn-child", asyncChild ? "async_subagent" : "subagent", { description: childTask });
                const parentScript = asyncChild
                    ? [spawn, text("Parent finished."), text("Child result received.")]
                    : [spawn, ...childScript, text("Parent finished.")];
                const parentAdapter = new FauxAdapter(parentScript);
                const childAdapter = new FauxAdapter(childScript);
                let adapterCount = 0;
                const registry = new AgentRegistry({
                    createAdapter() {
                        if (worker) return new FauxAdapter([]);
                        adapterCount += 1;
                        return asyncChild && adapterCount > 1 ? childAdapter : parentAdapter;
                    },
                    ...(worker ? {
                        workerAdapterSpec: ({ sessionId }) => ({
                            module: adapterModule,
                            options: {
                                script: asyncChild && sessionId !== "parent" ? childScript : parentScript,
                                pidPath: join(root, `${sessionId}.pid`),
                            },
                        }),
                    } : {}),
                    model: "faux/test",
                    approvalMode: "auto",
                    reviewer: { models: [{ provider: "faux", model: "reviewer" }] },
                    sessionPathForId: (id) => join(root, `${id}.jsonl`),
                    eventLogPathForId: (id) => join(root, `${id}-events.jsonl`),
                });
                try {
                    const parent = await registry.create({ id: "parent", workspace: root, sessionPath: join(root, "parent.jsonl") });
                    const attachment = parent.attach();
                    expect((await attachment.receive()).type).toBe("history");
                    attachment.send({ type: "prompt", content: "Start the child task." });
                    let requestUpdate: AgentUpdate | undefined;
                    const observed: AgentUpdate[] = [];
                    const deadline = Date.now() + 8_000;
                    while (Date.now() < deadline) {
                        const update = await Promise.race([
                            attachment.receive(),
                            Bun.sleep(deadline - Date.now()).then(() => {
                                throw new Error(`Timed out waiting for child denial: ${JSON.stringify(observed)}`);
                            }),
                        ]);
                        observed.push(update);
                        if (update.type === "turn_finished" && !asyncChild) {
                            throw new Error(`Parent finished before child denial: ${JSON.stringify(observed)}`);
                        }
                        if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
                            requestUpdate = update;
                            break;
                        }
                    }
                    expect(requestUpdate?.type).toBe("ui_request");
                    if (!requestUpdate || requestUpdate.type !== "ui_request" || !isToolApprovalUiRequestUpdate(requestUpdate)) throw new Error("Expected relayed denial request");
                    expect(requestUpdate.request).toMatchObject({
                        toolCall: { name: "bash", input: { command: `printf crow > '${outside}'` } },
                        sourceAgentId: expect.any(String),
                        sourceTask: childTask,
                        restrictedChoices: true,
                        allowNotes: false,
                        review: { decision: "deny", reason: "The crow did not authorize this action.", riskLevel: "high", model: "faux/reviewer" },
                    });
                    attachment.send({ type: "ui_response", requestId: requestUpdate.requestId, response: { type: "tool_approval", decision: answer } });
                    await receiveUntil(attachment, (update) =>
                        update.type === (asyncChild ? "task_notification" : "turn_finished")
                    );
                    if (answer === "allow_once") expect(await readFile(outside, "utf8")).toBe("crow");
                    else await expect(readFile(outside, "utf8")).rejects.toThrow();
                    attachment.detach();
                } finally {
                    const pidFiles = (await readdir(root)).filter((name) => name.endsWith(".pid"));
                    const pids = await Promise.all(pidFiles.map(async (name) =>
                        Number(await readFile(join(root, name), "utf8"))
                    ));
                    await registry.close();
                    for (const pid of pids) if (pid > 0) await expectWorkerExit(pid);
                    await rm(root, { recursive: true, force: true });
                    await rm(outside, { force: true });
                }
            }, 60_000);
        }
    }
}
