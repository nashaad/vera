import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import { InboxAdmissionPolicy } from "../../src/host/inbox-admission.ts";
import { InboxDeliveryCoordinator } from "../../src/host/inbox-delivery.ts";
import { ProcessObservationCoordinator } from "../../src/host/process-observations.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type AssistantMessage, type ModelRequest } from "../../src/model/types.ts";
import { Inbox } from "../../src/store/inbox.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("@core a process notice waits for a busy turn and passes an unanswered inbox question", async () => {
    const root = join(tmpdir(), "vera-dev");
    await mkdir(root, { recursive: true });
    const home = await mkdtemp(join(root, "monitor-order-"));
    const inbox = Inbox.open(join(home, "inbox.db"));
    const delivery = new InboxDeliveryCoordinator(new ConsumerRegistry(inbox, "node-crow"), {
        admission: new InboxAdmissionPolicy({ user: [], userConfigPath: join(home, "config.json") }),
    });
    const observations = new ProcessObservationCoordinator(inbox, delivery, {
        async formatProcessOutcome() { return "Crow command exited with the map."; },
    });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const faux = new FauxAdapter([
        text("Crow finished working."), text("Crow saw the map."), text("Crow heard the report."), text("Crow is ready."),
    ]);
    let calls = 0;
    const registry = new AgentRegistry({
        home, model: "faux/test", approvalMode: "auto", inboxDelivery: delivery,
        createAdapter: () => ({
            stream(request: ModelRequest) {
                const source = faux.stream(request);
                if (++calls !== 1) return source;
                entered.resolve();
                const stream = new ModelEventStream();
                void (async () => {
                    for await (const event of source) {
                        if (event.type !== "start") await gate.promise;
                        stream.push(event);
                    }
                })();
                return stream;
            },
        }),
    });
    const path = join(home, "crow-owner.jsonl");
    try {
        const owner = await registry.create({ id: "crow-owner", workspace: home, sessionPath: path });
        const attachment = owner.attach();
        await attachment.receive();
        attachment.send({ type: "prompt", content: "Keep working on the map." });
        await Promise.race([entered.promise, Bun.sleep(5_000).then(() => { throw new Error("Crow turn did not start"); })]);
        const start = {
            ownerId: owner.id, processId: "p-crow-order", extensionId: "vera.monitor",
            description: "Crow checks the hold", pid: 2_000_000_001, startedAt: new Date().toISOString(),
        };
        observations.start("local:crow", start);
        await observations.settle("local:crow", {
            ...start, elapsedMs: 10, exitCode: 0, outputTail: "map", outputTruncated: false,
        });
        expect(inbox.tail()).toBe(1);
        gate.resolve();
        const first = await receiveThroughTurn(attachment);
        const second = await receiveThroughTurn(attachment);
        expect(JSON.stringify(first)).toContain("Crow finished working.");
        expect(JSON.stringify(second)).toContain("Crow saw the map.");
        const transcript = await readFile(path, "utf8");
        expect(transcript).toContain("Crow command exited with the map.");
        expect(transcript.indexOf("Crow finished working.")).toBeLessThan(transcript.indexOf("Crow saw the map."));

        await delivery.append({ source: "watch/crow", kind: "filesystem.changed", address: owner.id, payload: "{}" });
        const question = await receiveType(attachment, "ui_request");
        expect(question.request).toMatchObject({ type: "user_question" });
        const nextStart = { ...start, processId: "p-crow-question" };
        observations.start("local:crow", nextStart);
        await observations.settle("local:crow", {
            ...nextStart, elapsedMs: 10, exitCode: 0, outputTail: "map", outputTruncated: false,
        });
        expect(JSON.stringify(await receiveThroughTurn(attachment))).toContain("Crow heard the report.");
        expect(inbox.offsetOf({ nodeId: "node-crow", label: owner.id })).toBe(1);
        attachment.send({
            type: "ui_response", requestId: question.requestId,
            response: { type: "user_question", outcome: "cancelled" },
        });
        attachment.send({ type: "prompt", content: "Are you ready?" });
        expect(JSON.stringify(await receiveThroughTurn(attachment))).toContain("Crow is ready.");
        attachment.detach();
    } finally {
        gate.resolve();
        await registry.close();
        delivery.close();
        inbox.close();
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

function text(value: string): AssistantMessage {
    return {
        role: "assistant", content: [{ type: "text", text: value }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop",
    };
}

async function receiveType<T extends "ui_request" | "status">(attachment: AgentAttachment, type: T) {
    while (true) {
        const update = await attachment.receive(AbortSignal.timeout(5_000));
        if (update.type === type) return update as Extract<typeof update, { readonly type: T }>;
    }
}

async function receiveThroughTurn(attachment: AgentAttachment): Promise<unknown[]> {
    const updates: unknown[] = [];
    while (true) {
        const update = await attachment.receive(AbortSignal.timeout(5_000));
        updates.push(update);
        if (update.type === "turn_finished") return updates;
    }
}
