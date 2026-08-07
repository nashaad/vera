import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import {
    ResidentAgentClosedError,
    type AgentAttachment,
} from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("a bounded run reads its workspace through the ordinary turn path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-"));
    await writeFile(join(root, "marker.txt"), "workspace content");
    const registry = createRegistry(() => readMarkerScript());
    const sessionPath = join(root, "run.jsonl");

    try {
        const result = await registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath,
            eventLogPath: join(root, "events.jsonl"),
            prompt: "read the marker",
        });

        expect(result.outcome).toBe("completed");
        expect(result.text).toBe("done");
        expect(result.sessionPath).toBe(sessionPath);
        // The tool ran, so the run went through the ordinary loop and tools,
        // and the ordinary session store holds the transcript afterwards.
        const session = await readFile(sessionPath, "utf8");
        expect(session).toContain("workspace content");
        // Closed, and closed once: the second close finds nothing.
        expect(registry.list().some((agent) => agent.id === "bounded"))
            .toBe(false);
        expect(registry.find("bounded")).toBeUndefined();
        expect(await registry.closeAgent("bounded")).toBe("not_found");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a bounded run reports a turn error and still closes its agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-error-"));
    const registry = createRegistry(() => [thinkingOnlyResponse()]);

    try {
        const result = await registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "say something",
        });

        expect(result.outcome).toBe("error");
        expect(result.error).toBeDefined();
        expect(registry.find("bounded")).toBeUndefined();
        expect(await registry.closeAgent("bounded")).toBe("not_found");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a bounded agent lists and attaches like any other while it runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-attach-"));
    await writeFile(join(root, "marker.txt"), "workspace content");
    const registry = createRegistry(() => readMarkerScript());

    try {
        const run = registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "read the marker",
        });

        const agent = await waitForAgent(registry, "bounded");
        expect(registry.list().some((summary) => summary.id === "bounded"))
            .toBe(true);
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");

        const result = await run;
        expect(result.outcome).toBe("completed");
        // The close an attached client sees is the ordinary closed path.
        await expect(attachment.receive()).rejects.toBeInstanceOf(
            ResidentAgentClosedError,
        );
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an attached client sees the closed path when the bounded run errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-attach-error-"));
    const registry = createRegistry(() => [thinkingOnlyResponse()]);

    try {
        const run = registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "say something",
        });
        const agent = await waitForAgent(registry, "bounded");
        const attachment = agent.attach();

        expect((await run).outcome).toBe("error");
        await expect(drain(attachment)).rejects.toBeInstanceOf(
            ResidentAgentClosedError,
        );
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a client that dies mid-run cannot leak the bounded agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-death-"));
    await writeFile(join(root, "marker.txt"), "workspace content");
    const registry = createRegistry(() => readMarkerScript());

    try {
        const run = registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "read the marker",
        });
        const agent = await waitForAgent(registry, "bounded");
        const attachment = agent.attach();
        await attachment.receive();
        attachment.detach();

        expect((await run).outcome).toBe("completed");
        expect(registry.find("bounded")).toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a prompt from an attached client is refused by name, not queued", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-prompt-"));
    await writeFile(join(root, "marker.txt"), "workspace content");
    const registry = createRegistry(() => readMarkerScript());

    try {
        const run = registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "read the marker",
        });
        const agent = await waitForAgent(registry, "bounded");
        const attachment = agent.attach();
        attachment.send({ type: "prompt", content: "do something else" });

        const refusal = await receiveOfType(attachment, "prompt_rejected");
        expect(refusal).toMatchObject({
            type: "prompt_rejected",
            reason: expect.stringContaining("single bounded turn"),
        });

        const result = await run;
        expect(result.outcome).toBe("completed");
        // The refused prompt started no second turn, so the transcript holds
        // only the prompt the run was started with.
        const session = await readFile(join(root, "run.jsonl"), "utf8");
        expect(session).not.toContain("do something else");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a bounded run denies approvals it cannot ask about", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-approval-"));
    await writeFile(join(root, "marker.txt"), "workspace content");
    const registry = createRegistry(() => bashScript());

    try {
        const result = await registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "run the command",
            approvalMode: "ask",
        });

        expect(result.notes.length).toBeGreaterThan(0);
        expect(result.notes.join("\n")).toContain("Denied bash");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

async function writeProjectPool(
    root: string,
    models: Record<string, unknown>,
): Promise<void> {
    await mkdir(join(root, ".vera"), { recursive: true });
    await writeFile(
        join(root, ".vera", "pool.json"),
        JSON.stringify({ models }),
    );
}

function createRegistry(script: () => AssistantMessage[]): AgentRegistry {
    return new AgentRegistry({
        createAdapter: () => new FauxAdapter(script()),
        model: "faux/test",
        approvalMode: "auto",
    });
}

async function waitForAgent(
    registry: AgentRegistry,
    id: string,
): Promise<ReturnType<AgentRegistry["find"]> & {}> {
    while (true) {
        const agent = registry.find(id);
        if (agent !== undefined) {
            return agent;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

async function receiveOfType(
    attachment: AgentAttachment,
    type: string,
): Promise<{ readonly type: string }> {
    while (true) {
        const update = await attachment.receive();
        if (update.type === type) {
            return update;
        }
    }
}

async function drain(attachment: AgentAttachment): Promise<never> {
    while (true) {
        await attachment.receive();
    }
}

function thinkingOnlyResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "thinking", text: "no structured call" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function bashScript(): AssistantMessage[] {
    return [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "bash-once",
                name: "bash",
                input: { command: "rm -rf /tmp/vera-run-once-nothing" },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ];
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
        {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ];
}

test("a bounded run takes its pooled model by name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-model-"));
    await writeFile(join(root, "marker.txt"), "workspace content");
    await writeProjectPool(root, {
        "openrouter/other-test-model": { added: true, name: "frosty" },
    });
    const registry = createRegistry(() => readMarkerScript());

    try {
        const result = await registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "read the marker",
            modelRef: "frosty",
        });

        expect(result.outcome).toBe("completed");
        const session = await readFile(join(root, "run.jsonl"), "utf8");
        expect(session).toContain("other-test-model");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a bounded run refuses a model the pool does not hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-unpooled-"));
    const registry = createRegistry(() => readMarkerScript());

    try {
        await expect(registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "read the marker",
            modelRef: "openrouter/never-pooled-model",
        })).rejects.toThrow("is not in the pool");

        expect(registry.find("bounded")).toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an unknown effort coerces and the run still starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-run-once-coerced-"));
    const registry = createRegistry(() => readMarkerScript());

    try {
        // One coercion rule everywhere: an effort the model does not publish
        // becomes its default (else a middle level), never a refusal.
        const outcome = await registry.runOnce({
            id: "bounded",
            workspace: root,
            sessionPath: join(root, "run.jsonl"),
            eventLogPath: join(root, "events.jsonl"),
            prompt: "read the marker",
            reasoningEffort: "not-a-level",
        });
        expect(outcome).toBeDefined();
        const session = await readFile(join(root, "run.jsonl"), "utf8");
        expect(session).toContain("read the marker");
        expect(session).not.toContain("not-a-level");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});
