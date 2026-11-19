import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { isToolApprovalUiRequestUpdate, type AgentUpdate } from "../../src/engine/protocol.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const adapterModule = fileURLToPath(new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url));
const source = { provider: "faux", api: "scripted", model: "test" } as const;

function text(value: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: value }],
        source,
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function receiveUntil(
    attachment: AgentAttachment,
    wanted: (update: AgentUpdate) => boolean,
): Promise<AgentUpdate> {
    const updates: AgentUpdate[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const update = await Promise.race([
            attachment.receive(),
            Bun.sleep(deadline - Date.now()).then(() => {
                throw new Error(`Timed out waiting for update: ${JSON.stringify(updates)}`);
            }),
        ]);
        updates.push(update);
        if (wanted(update)) return update;
        if (update.type === "turn_finished") {
            throw new Error(`Turn finished before expected update: ${JSON.stringify(updates)}`);
        }
    }
    throw new Error(`Timed out waiting for update: ${JSON.stringify(updates)}`);
}

async function expectWorkerExit(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        await Bun.sleep(20);
    }
    throw new Error(`Worker ${pid} did not exit`);
}

for (const worker of [false, true]) {
    for (const answer of ["allow_once", "deny"] as const) {
        test(`@core resident ${worker ? "worker" : "in-process"} classifier denial ${answer}`, async () => {
            const root = await mkdtemp(join(tmpdir(), "vera-resident-denial-"));
            const marker = `${root}-marker`;
            const path = join(root, "session.jsonl");
            const script: AssistantMessage[] = [
                {
                    role: "assistant",
                    content: [{
                        type: "tool_call",
                        id: "write-crow",
                        name: "bash",
                        input: { command: `printf crow > ${marker}` },
                    }],
                    source,
                    usage: emptyUsage(),
                    stopReason: "tool_use",
                },
                text(JSON.stringify({
                    risk_level: "high",
                    user_authorization: "unknown",
                    outcome: "deny",
                    rationale: "The crow did not authorize this action.",
                })),
                text("Turn complete."),
            ];
            const registry = new AgentRegistry({
                createAdapter: () => new FauxAdapter(script),
                ...(worker ? {
                    workerAdapterSpec: () => ({
                        module: adapterModule,
                        options: { script, pidPath: join(root, "worker.pid") },
                    }),
                } : {}),
                model: "test",
                provider: "faux",
                approvalMode: "auto",
                reviewer: { models: [{ provider: "faux", model: "reviewer" }] },
            });
            try {
                const resident = await registry.create({ id: "crow", workspace: root, sessionPath: path });
                const attachment = resident.attach();
                expect((await attachment.receive()).type).toBe("history");
                attachment.send({ type: "prompt", content: "Prepare the ship." });
                const update = await receiveUntil(attachment, (next) =>
                    next.type === "ui_request" && isToolApprovalUiRequestUpdate(next)
                );
                if (update.type !== "ui_request" || !isToolApprovalUiRequestUpdate(update)) {
                    throw new Error("Expected an approval request");
                }
                expect(update.request).toMatchObject({
                    toolCall: { name: "bash", input: { command: `printf crow > ${marker}` } },
                    restrictedChoices: true,
                    allowNotes: false,
                    review: {
                        decision: "deny",
                        reason: "The crow did not authorize this action.",
                        riskLevel: "high",
                        model: "faux/reviewer",
                    },
                });
                attachment.send({
                    type: "ui_response",
                    requestId: update.requestId,
                    response: { type: "tool_approval", decision: answer },
                });
                const finished = await receiveUntil(attachment, (next) => next.type === "turn_finished");
                expect(finished.type).toBe("turn_finished");
                if (answer === "allow_once") {
                    expect(await readFile(marker, "utf8")).toBe("crow");
                } else {
                    await expect(readFile(marker, "utf8")).rejects.toThrow();
                }
                const reopened = await SessionStore.open(path);
                const result = reopened.messages().find((message) =>
                    message.role === "tool_result" && message.toolCallId === "write-crow"
                );
                expect(result?.role).toBe("tool_result");
                if (result?.role === "tool_result") {
                    if (answer === "allow_once") {
                        expect(result.withheld).not.toBe(true);
                        expect(result.classifierOutcome).toBeUndefined();
                    } else {
                        expect(result.withheld).toBe(true);
                        expect(result.classifierOutcome).toMatchObject({ kind: "denied", riskLevel: "high" });
                    }
                }
                attachment.detach();
            } finally {
                const pid = worker
                    ? Number(await readFile(join(root, "worker.pid"), "utf8").catch(() => "0"))
                    : 0;
                await registry.close();
                if (pid > 0) await expectWorkerExit(pid);
                await rm(root, { recursive: true, force: true });
                await rm(marker, { force: true });
            }
        }, 20_000);
    }
}

for (const worker of [false, true]) {
    test(`@core ${worker ? "worker" : "in-process"} session shares the denial cap with child relays`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-resident-denial-cap-"));
        const marker = `${root}-marker`;
        const script: AssistantMessage[] = [
            {
                role: "assistant",
                content: [{
                    type: "tool_call",
                    id: "write-crow",
                    name: "bash",
                    input: { command: `printf crow > ${marker}` },
                }],
                source,
                usage: emptyUsage(),
                stopReason: "tool_use",
            },
            text(JSON.stringify({
                risk_level: "high",
                user_authorization: "unknown",
                outcome: "deny",
                rationale: "The crow did not authorize this action.",
            })),
            text("Turn complete."),
        ];
        const registry = new AgentRegistry({
            createAdapter: () => new FauxAdapter(script),
            ...(worker ? {
                workerAdapterSpec: () => ({
                    module: adapterModule,
                    options: { script, pidPath: join(root, "worker.pid") },
                }),
            } : {}),
            model: "test",
            provider: "faux",
            approvalMode: "auto",
            reviewer: { models: [{ provider: "faux", model: "reviewer" }] },
        });
        const abort = new AbortController();
        try {
            const resident = await registry.create({
                id: "crow",
                workspace: root,
                sessionPath: join(root, "session.jsonl"),
            });
            const attachment = resident.attach();
            expect((await attachment.receive()).type).toBe("history");
            attachment.send({ type: "prompt", content: "Prepare the ship." });
            const rootRequest = await receiveUntil(attachment, (next) =>
                next.type === "ui_request" && isToolApprovalUiRequestUpdate(next)
            );
            if (rootRequest.type !== "ui_request" || !isToolApprovalUiRequestUpdate(rootRequest)) {
                throw new Error("Expected the parent approval");
            }
            const entry = registry.agents.get("crow");
            if (entry === undefined) throw new Error("Expected the parent session");
            const pending: Promise<"allow_once" | "deny">[] = [];
            const childRequestIds: string[] = [];
            for (let index = 0; index < 15; index += 1) {
                pending.push(registry.relayChildToolApproval(
                    entry, rootRequest, `child-${index}`, "Inspect the hold", abort.signal,
                ));
                const childRequest = await receiveUntil(attachment, (next) =>
                    next.type === "ui_request"
                    && isToolApprovalUiRequestUpdate(next)
                    && next.request.sourceAgentId === `child-${index}`
                );
                if (childRequest.type !== "ui_request" || !isToolApprovalUiRequestUpdate(childRequest)) {
                    throw new Error("Expected the child approval");
                }
                expect(childRequest.request).toMatchObject({
                    restrictedChoices: true,
                    allowNotes: false,
                    review: rootRequest.request.review,
                });
                childRequestIds.push(childRequest.requestId);
            }
            const overflow = registry.relayChildToolApproval(
                entry, rootRequest, "child-overflow", "Inspect the hold", abort.signal,
            );
            expect(await Promise.race([
                overflow,
                Bun.sleep(2_000).then(() => "timed_out" as const),
            ])).toBe("deny");
            attachment.send({
                type: "ui_response",
                requestId: childRequestIds.shift()!,
                response: { type: "tool_approval", decision: "deny" },
            });
            expect(await pending[0]).toBe("deny");
            const replacement = registry.relayChildToolApproval(
                entry, rootRequest, "child-replacement", "Inspect the hold", abort.signal,
            );
            const replacementRequest = await receiveUntil(attachment, (next) =>
                next.type === "ui_request"
                && isToolApprovalUiRequestUpdate(next)
                && next.request.sourceAgentId === "child-replacement"
            );
            if (replacementRequest.type !== "ui_request" || !isToolApprovalUiRequestUpdate(replacementRequest)) {
                throw new Error("Expected the replacement approval");
            }
            attachment.send({
                type: "ui_response",
                requestId: replacementRequest.requestId,
                response: { type: "tool_approval", decision: "deny" },
            });
            expect(await replacement).toBe("deny");
            for (const requestId of childRequestIds) {
                attachment.send({
                    type: "ui_response",
                    requestId,
                    response: { type: "tool_approval", decision: "deny" },
                });
            }
            await Promise.all(pending);
            attachment.send({
                type: "ui_response",
                requestId: rootRequest.requestId,
                response: { type: "tool_approval", decision: "deny" },
            });
            await receiveUntil(attachment, (next) => next.type === "turn_finished");
            attachment.detach();
        } finally {
            abort.abort();
            const pid = worker
                ? Number(await readFile(join(root, "worker.pid"), "utf8").catch(() => "0"))
                : 0;
            await registry.close();
            if (pid > 0) await expectWorkerExit(pid);
            await rm(root, { recursive: true, force: true });
            await rm(marker, { force: true });
        }
    }, 20_000);
}
