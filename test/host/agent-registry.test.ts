import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("resident agents keep file tools inside their fixed workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-registry-"));
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    await writeFile(join(firstWorkspace, "marker.txt"), "first workspace");
    await writeFile(join(secondWorkspace, "marker.txt"), "second workspace");

    const registry = createRegistry(() => readMarkerScript());
    const firstSession = join(root, "first.jsonl");
    const secondSession = join(root, "second.jsonl");

    try {
        const first = await registry.create({
            id: "first",
            workspace: firstWorkspace,
            sessionPath: firstSession,
            eventLogPath: join(root, "first-events.jsonl"),
        });
        const second = await registry.create({
            id: "second",
            workspace: secondWorkspace,
            sessionPath: secondSession,
            eventLogPath: join(root, "second-events.jsonl"),
        });

        await runPrompt(first.attach(), "read your marker");
        await runPrompt(second.attach(), "read your marker");

        expect(await toolResultText(firstSession)).toBe("first workspace");
        expect(await toolResultText(secondSession)).toBe("second workspace");
        expect(registry.list()).toEqual([
            {
                id: "first",
                workspace: await realpath(firstWorkspace),
                session_path: firstSession,
                status: "idle",
            },
            {
                id: "second",
                workspace: await realpath(secondWorkspace),
                session_path: secondSession,
                status: "idle",
            },
        ]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a registry resumes the same resident agent from its session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-resume-"));
    const workspace = join(root, "workspace");
    const sessionPath = join(root, "agent.jsonl");
    await mkdir(workspace);

    const firstRegistry = createRegistry(() => [textResponse("first reply")]);
    try {
        const original = await firstRegistry.create({
            id: "durable-agent",
            workspace,
            sessionPath,
            eventLogPath: join(root, "first-events.jsonl"),
        });
        await runPrompt(original.attach(), "first prompt");
    } finally {
        await firstRegistry.close();
    }

    const resumedRegistry = createRegistry(() => [textResponse("second reply")]);
    try {
        const resumed = await resumedRegistry.resume({
            sessionPath,
            eventLogPath: join(root, "second-events.jsonl"),
        });
        expect(resumed.id).toBe("durable-agent");
        expect(resumed.workspace).toBe(await realpath(workspace));

        const attachment = resumed.attach();
        const history = await attachment.receive();
        expect(history.type).toBe("history");
        if (history.type !== "history") {
            throw new Error("Expected resumed history");
        }
        expect(history.entries).toEqual([
            { kind: "user", text: "first prompt" },
            { kind: "assistant", text: "first reply" },
        ]);

        await runPrompt(attachment, "second prompt", false);
        expect(resumedRegistry.find("durable-agent")).toBe(resumed);

        const store = await SessionStore.open(sessionPath);
        expect(store.header).toMatchObject({
            id: "durable-agent",
            cwd: await realpath(workspace),
        });
        expect(store.messages().filter((message) => message.role === "user"))
            .toHaveLength(2);
    } finally {
        await resumedRegistry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a registry reserves IDs while agents start and stays closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-lifecycle-"));
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    const registry = createRegistry(() => [textResponse("unused")]);

    try {
        const attempts = await Promise.allSettled([
            registry.create({
                id: "same-id",
                workspace: firstWorkspace,
                sessionPath: join(root, "first.jsonl"),
                eventLogPath: join(root, "first-events.jsonl"),
            }),
            registry.create({
                id: "same-id",
                workspace: secondWorkspace,
                sessionPath: join(root, "second.jsonl"),
                eventLogPath: join(root, "second-events.jsonl"),
            }),
        ]);
        expect(attempts.map((result) => result.status).sort()).toEqual([
            "fulfilled",
            "rejected",
        ]);
        expect(registry.list()).toHaveLength(1);

        await registry.close();
        await expect(registry.create({
            id: "too-late",
            workspace: firstWorkspace,
            sessionPath: join(root, "late.jsonl"),
        })).rejects.toThrow("Agent registry is closed");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an adapter construction failure does not register an agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-adapter-"));
    const registry = new AgentRegistry({
        createAdapter(): never {
            throw new Error("adapter unavailable");
        },
        model: "faux/test",
        approvalMode: "approve_for_me",
    });

    try {
        await expect(registry.create({
            id: "failed-agent",
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        })).rejects.toThrow("adapter unavailable");
        expect(registry.list()).toEqual([]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

function createRegistry(script: () => AssistantMessage[]): AgentRegistry {
    return new AgentRegistry({
        createAdapter: () => new FauxAdapter(script()),
        model: "faux/test",
        approvalMode: "approve_for_me",
    });
}

function readMarkerScript(): AssistantMessage[] {
    return [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "read-marker",
                name: "read",
                input: { path: "marker.txt" },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        textResponse("done"),
    ];
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function runPrompt(
    attachment: AgentAttachment,
    content: string,
    consumeHistory = true,
): Promise<void> {
    if (consumeHistory) {
        expect((await attachment.receive()).type).toBe("history");
    }
    attachment.send({ type: "prompt", content });
    while ((await attachment.receive()).type !== "turn_finished") {
        // A client consumes the ordered update stream until the turn boundary.
    }
}

async function toolResultText(sessionPath: string): Promise<string | undefined> {
    const store = await SessionStore.open(sessionPath);
    const result = store.messages().find(
        (message) => message.role === "tool_result",
    );
    return result?.role === "tool_result" ? result.content[0]?.text : undefined;
}
