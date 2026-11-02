import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function untilRegistryValue<T>(
    read: () => T | undefined,
    timeoutMs = 2_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) {
            throw new Error("condition did not hold in time");
        }
        await Bun.sleep(10);
    }
}

async function receiveTurnFinished(
    attachment: AgentAttachment,
): Promise<void> {
    while ((await attachment.receive()).type !== "turn_finished") {
        // A client consumes the ordered update stream until the turn boundary.
    }
}

// A side conversation branches the primary while it is mid-turn, which is the
// normal way `/btw` is used. The branch copies only completed entries, so the
// source being busy is not a reason to refuse.
test("a branch snapshots a source that is still working", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-branch-working-"));
    const registry = new AgentRegistry({
        createAdapter: () => ({
            stream(request) {
                return new FauxAdapter(
                    [textResponse("slow answer")],
                    { delayMs: 300 },
                ).stream(request);
            },
        }),
        model: "faux/test",
        approvalMode: "auto",
    });

    try {
        const primary = await registry.create({
            id: "primary",
            workspace: root,
            sessionPath: join(root, "primary.jsonl"),
        });
        const client = primary.attach();
        await client.receive();
        client.send({ type: "prompt", content: "P1" });
        await untilRegistryValue(() =>
            registry.find("primary")?.status === "working" ? true : undefined
        );

        const branch = await registry.branch({
            sourceId: "primary",
            position: "at",
            id: "side",
            sessionPath: join(root, "side.jsonl"),
            hideInheritedMessages: true,
        });
        expect(branch?.agent.id).toBe("side");

        const sideStore = await SessionStore.open(join(root, "side.jsonl"));
        expect(sideStore.messages().map((message) => message.role))
            .not.toContain("assistant");

        await receiveTurnFinished(client);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});
