import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolHooks } from "../../src/engine/hooks.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

interface BranchVariant {
    readonly name: string;
    readonly deferPublication: boolean;
    readonly ephemeral: boolean;
}

const VARIANTS: readonly BranchVariant[] = [
    { name: "plain", deferPublication: false, ephemeral: false },
    { name: "deferred", deferPublication: true, ephemeral: false },
    { name: "ephemeral", deferPublication: true, ephemeral: true },
];

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
): Promise<void> {
    expect((await attachment.receive()).type).toBe("history");
    attachment.send({ type: "prompt", content });
    while ((await attachment.receive()).type !== "turn_finished") {
        // A client consumes the ordered update stream until the turn boundary.
    }
}

for (const variant of VARIANTS) {
    test(`a branch that fails while starting leaves no agent behind (${variant.name})`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-branch-failure-"));
        const sourcePath = join(root, "source.jsonl");
        const forkPath = join(root, "fork.jsonl");
        // createToolHooks runs inside start(), after the entry is registered.
        let failStart = false;
        const ended: string[] = [];
        const registry = new AgentRegistry({
            onSessionEnd: (payload) => {
                ended.push(payload.sessionId);
            },
            createAdapter: () => new FauxAdapter([
                textResponse("first answer"),
                textResponse("second answer"),
            ]),
            model: "faux/test",
            approvalMode: "auto",
            createToolHooks: () => {
                if (failStart) {
                    throw new Error("tool hooks unavailable");
                }
                return new ToolHooks();
            },
        });
        const branchFork = () => registry.branch({
            sourceId: "source",
            position: "at",
            id: "fork",
            ...(variant.ephemeral ? { ephemeral: true } : { sessionPath: forkPath }),
            ...(variant.deferPublication ? { deferPublication: true } : {}),
        });

        try {
            const created = await registry.create({
                id: "source",
                workspace: root,
                sessionPath: sourcePath,
            });
            await runPrompt(created.attach(), "first prompt");
            await registry.closeAgent("source");
            expect(registry.list()).toEqual([]);
            const source = await registry.resume({ sessionPath: sourcePath });
            const sourceBytes = await readFile(sourcePath, "utf8");

            failStart = true;
            await expect(branchFork()).rejects.toThrow("tool hooks unavailable");
            failStart = false;

            expect(registry.agents.has("fork")).toBe(false);
            expect(registry.startingIds.has("fork")).toBe(false);
            expect(ended).not.toContain("fork");
            expect(registry.list().map((agent) => agent.id)).toEqual(["source"]);
            expect(existsSync(forkPath)).toBe(false);
            expect(existsSync(`${forkPath}.attachments`)).toBe(false);
            expect((await readdir(root)).sort()).toEqual(["source.jsonl"]);
            expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
            expect(registry.find("source")).toBe(source);
            await runPrompt(source.attach(), "second prompt");

            const branched = await branchFork();
            expect(branched?.agent.id).toBe("fork");
            expect(registry.agents.has("fork")).toBe(true);
            if (!variant.ephemeral) {
                expect(existsSync(forkPath)).toBe(true);
            }
        } finally {
            await registry.close();
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("a branch refused for a taken id leaves the agent that owns it running", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-branch-taken-id-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("answer")]),
        model: "faux/test",
        approvalMode: "auto",
    });

    try {
        const source = await registry.create({
            id: "source",
            workspace: root,
            sessionPath: join(root, "source.jsonl"),
        });

        await expect(registry.branch({
            sourceId: "source",
            position: "at",
            id: "source",
            sessionPath: join(root, "other.jsonl"),
        })).rejects.toThrow("already exists");

        expect(registry.find("source")).toBe(source);
        await runPrompt(source.attach(), "still here");
        expect((await readdir(root)).sort()).toEqual(["source.jsonl"]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

interface StartFailureHarness {
    readonly root: string;
    readonly registry: AgentRegistry;
    readonly ended: string[];
    failStart(fail: boolean): void;
}

// createToolHooks runs inside start(), after the entry is registered and before the loop starts.
async function withStartFailure(
    run: (harness: StartFailureHarness) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "vera-start-failure-"));
    let failing = false;
    const ended: string[] = [];
    const registry = new AgentRegistry({
        onSessionEnd: (payload) => {
            ended.push(payload.sessionId);
        },
        createAdapter: () => new FauxAdapter([
            textResponse("first answer"),
            textResponse("second answer"),
        ]),
        model: "faux/test",
        approvalMode: "auto",
        createToolHooks: () => {
            if (failing) {
                throw new Error("tool hooks unavailable");
            }
            return new ToolHooks();
        },
    });
    try {
        await run({
            root,
            registry,
            ended,
            failStart: (fail) => {
                failing = fail;
            },
        });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
}

test("a resume that fails while starting leaves no agent and keeps the session", async () => {
    await withStartFailure(async ({ root, registry, ended, failStart }) => {
        const sessionPath = join(root, "saved.jsonl");
        const created = await registry.create({
            id: "saved",
            workspace: root,
            sessionPath,
        });
        await runPrompt(created.attach(), "first prompt");
        await registry.closeAgent("saved");
        const savedBytes = await readFile(sessionPath, "utf8");

        failStart(true);
        await expect(registry.resume({ sessionPath }))
            .rejects.toThrow("tool hooks unavailable");
        failStart(false);

        expect(registry.agents.has("saved")).toBe(false);
        expect(registry.startingIds.has("saved")).toBe(false);
        expect(registry.find("saved")).toBeUndefined();
        expect(ended).toEqual(["saved"]);
        expect(await readFile(sessionPath, "utf8")).toBe(savedBytes);
        const resumed = await registry.resume({ sessionPath });
        await runPrompt(resumed.attach(), "second prompt");
    });
});

test("a create that fails while starting sends no session_end and leaves no file", async () => {
    await withStartFailure(async ({ root, registry, ended, failStart }) => {
        failStart(true);
        await expect(registry.create({
            id: "fresh",
            workspace: root,
            sessionPath: join(root, "fresh.jsonl"),
        })).rejects.toThrow("tool hooks unavailable");
        failStart(false);

        expect(registry.agents.has("fresh")).toBe(false);
        expect(registry.startingIds.has("fresh")).toBe(false);
        expect(ended).toEqual([]);
        expect(await readdir(root)).toEqual([]);
    });
});

test("a branch that fails before its loop starts sends no session_end", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-branch-no-loop-"));
    const ended: string[] = [];
    const registry = new AgentRegistry({
        onSessionEnd: (payload) => {
            ended.push(payload.sessionId);
        },
        createAdapter: () => new FauxAdapter([textResponse("answer")]),
        model: "faux/test",
        approvalMode: "auto",
    });
    // Read in start() after the loop's services are built and before the loop runs.
    const workerAdapterSpecFor = registry.workerAdapterSpecFor.bind(registry);
    registry.workerAdapterSpecFor = (store, entry) => {
        if (store.header.id === "fork") {
            throw new Error("configuration unreadable");
        }
        return workerAdapterSpecFor(store, entry);
    };

    try {
        const source = await registry.create({
            id: "source",
            workspace: root,
            sessionPath: join(root, "source.jsonl"),
        });
        await runPrompt(source.attach(), "first prompt");

        await expect(registry.branch({
            sourceId: "source",
            position: "at",
            id: "fork",
            sessionPath: join(root, "fork.jsonl"),
        })).rejects.toThrow("configuration unreadable");

        expect(registry.agents.has("fork")).toBe(false);
        expect(ended).toEqual([]);
        expect((await readdir(root)).sort()).toEqual(["source.jsonl"]);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});
