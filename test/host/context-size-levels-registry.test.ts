import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import type { ContextSizeTriggerHookPayload } from "../../src/sdk/hooks.ts";
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

async function runPrompt(attachment: AgentAttachment, content: string): Promise<void> {
    expect((await attachment.receive()).type).toBe("history");
    attachment.send({ type: "prompt", content });
    while ((await attachment.receive()).type !== "turn_finished") {
        // A client consumes the ordered update stream until the turn boundary.
    }
}

test("context size levels fire once as context grows past them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-size-levels-"));
    const payloads: ContextSizeTriggerHookPayload[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([
            textResponse("one"),
            textResponse("two"),
        ]),
        model: "faux/test",
        approvalMode: "auto",
        contextLimit: () => 100_000,
        contextSizeLevels: () => [0.002, 0.001, 0.5],
        onContextSizeTrigger: (payload) => payloads.push(payload),
    });

    try {
        await registry.create({
            id: "ship",
            workspace: root,
            sessionPath: join(root, "ship.jsonl"),
        });
        const attachment = registry.find("ship")!.attach();
        await runPrompt(attachment, "first");
        const levels = payloads.filter((payload) => payload.reason === "level");
        expect(levels.map((payload) => payload.level)).toEqual([0.001, 0.002]);
        for (const payload of levels) {
            expect(payload.actions).toEqual([]);
            expect(payload.tokensAfter).toBe(payload.tokens);
            expect(payload.capacity).toBe(100_000);
            expect(payload.spawned).toBe(false);
        }

        await runPrompt(attachment, "second");
        expect(payloads.filter((payload) => payload.reason === "level")).toHaveLength(2);
        attachment.detach();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an ephemeral session never fires a context size level", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-size-levels-ephemeral-"));
    const payloads: ContextSizeTriggerHookPayload[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("one")]),
        model: "faux/test",
        approvalMode: "auto",
        contextLimit: () => 100_000,
        contextSizeLevels: () => [0.001],
        onContextSizeTrigger: (payload) => payloads.push(payload),
    });

    try {
        await registry.create({ id: "aside", workspace: root, ephemeral: true });
        const attachment = registry.find("aside")!.attach();
        await runPrompt(attachment, "first");
        expect(payloads).toEqual([]);
        attachment.detach();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a resumed session does not fire a level it already passed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-size-levels-resume-"));
    const sessionPath = join(root, "ship.jsonl");
    const firstPayloads: ContextSizeTriggerHookPayload[] = [];
    const options = {
        model: "faux/test",
        approvalMode: "auto" as const,
        contextLimit: () => 100_000,
        contextSizeLevels: () => [0.001],
    };
    const first = new AgentRegistry({
        ...options,
        createAdapter: () => new FauxAdapter([textResponse("one")]),
        onContextSizeTrigger: (payload) => firstPayloads.push(payload),
    });
    try {
        await first.create({ id: "ship", workspace: root, sessionPath });
        const attachment = first.find("ship")!.attach();
        await runPrompt(attachment, "first");
        attachment.detach();
        expect(firstPayloads.filter((payload) => payload.reason === "level")).toHaveLength(1);
    } finally {
        await first.close();
    }

    const resumedPayloads: ContextSizeTriggerHookPayload[] = [];
    const resumed = new AgentRegistry({
        ...options,
        createAdapter: () => new FauxAdapter([textResponse("two")]),
        onContextSizeTrigger: (payload) => resumedPayloads.push(payload),
    });
    try {
        await resumed.resume({ sessionPath });
        const attachment = resumed.find("ship")!.attach();
        await runPrompt(attachment, "second");
        attachment.detach();
        expect(resumedPayloads.filter((payload) => payload.reason === "level")).toEqual([]);
    } finally {
        await resumed.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("configured levels do not change the model request", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-size-levels-request-"));
    const runOnce = async (levels?: () => readonly number[]): Promise<ModelRequest[]> => {
        const requests: ModelRequest[] = [];
        const adapter: ModelAdapter = {
            stream(request) {
                requests.push(request);
                return new FauxAdapter([textResponse("done")]).stream(request);
            },
        };
        const registry = new AgentRegistry({
            createAdapter: () => adapter,
            model: "faux/test",
            approvalMode: "auto",
            contextLimit: () => 100_000,
            ...(levels === undefined ? {} : { contextSizeLevels: levels }),
            onContextSizeTrigger: () => {},
        });
        try {
            await registry.create({
                id: "ship",
                workspace: root,
                sessionPath: join(root, "ship.jsonl"),
            });
            const attachment = registry.find("ship")!.attach();
            await runPrompt(attachment, "same prompt");
            attachment.detach();
            return requests;
        } finally {
            await registry.close();
        }
    };

    try {
        const withoutLevels = await runOnce();
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });
        const withLevels = await runOnce(() => [0.001]);
        expect(withLevels).toHaveLength(1);
        const normalized = (requests: ModelRequest[]): string => JSON.stringify(requests)
            .replace(/"turnId":"[^"]*"/g, '"turnId":"turn"');
        expect(normalized(withLevels)).toBe(normalized(withoutLevels));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
