import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { finishDistributedCloseMember } from "../../src/host/agent-registry/lifecycle.ts";
import { sessionEndpoint } from "../../src/host/session-host/endpoint.ts";
import type { SessionHost } from "../../src/host/session-host/types.ts";
import { chatFolderPath } from "../../src/store/chat-folder.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function createRegistry(ended?: string[]): AgentRegistry {
    return new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        ...(ended === undefined ? {} : { onSessionEnd: (payload) => ended.push(payload.sessionId) }),
    });
}

test("@core a new root conversation remains fileless through setup and is discarded on idle park", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-session-"));
    const sessionPath = join(root, "unused.jsonl");
    const ended: string[] = [];
    const registry = createRegistry(ended);
    try {
        await registry.create({
            id: "unused",
            sessionPath,
            approvalMode: "auto",
        });
        const entry = registry.agents.get("unused")!;
        expect(entry.store.isMaterialized()).toBe(false);
        expect(entry.store.pendingRecords().length).toBeGreaterThan(0);
        expect(existsSync(sessionPath)).toBe(false);
        expect(existsSync(chatFolderPath(sessionPath))).toBe(true);
        expect(registry.list().map((item) => item.id)).toEqual(["unused"]);

        await registry.parkExpiredIdle(Date.now() + 11 * 60_000);

        expect(registry.find("unused")).toBeUndefined();
        expect(registry.list()).toEqual([]);
        expect(ended).toEqual(["unused"]);
        expect(existsSync(sessionPath)).toBe(false);
        expect(existsSync(chatFolderPath(sessionPath))).toBe(true);
        expect(await registry.closeAgentTree("unused")).toMatchObject({
            status: "not_found",
            closed: [],
        });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("an unused root remains fileless when its owner shuts down", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-unused-"));
    const sessionPath = join(root, "unused.jsonl");
    const registry = createRegistry();
    try {
        await registry.create({ id: "unused", workspace: root, sessionPath });
        expect(existsSync(sessionPath)).toBe(false);
        await registry.close();
        expect(existsSync(sessionPath)).toBe(false);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("distributed close discards an unused pending session without reporting it closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-distributed-close-"));
    const sessionPath = join(root, "pending.jsonl");
    const registry = createRegistry();
    try {
        const agent = await registry.create({ id: "pending", workspace: root, sessionPath });
        const entry = registry.agents.get(agent.id)!;
        entry.agent.close();
        await entry.run;

        expect(await finishDistributedCloseMember(registry, agent.id, entry, "closed"))
            .toBeUndefined();
        expect(registry.find(agent.id)).toBeUndefined();
        expect(registry.list()).toEqual([]);
        expect(existsSync(sessionPath)).toBe(false);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core an unwritten resident is not released for transfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-transfer-"));
    const sessionPath = join(root, "pending.jsonl");
    const registry = createRegistry();
    const endpoint = sessionEndpoint({
        registry,
        handlers: { releaseAgent: (id: string) => registry.releaseAgentTree(id) },
    } as unknown as SessionHost);
    try {
        await registry.create({ id: "pending", workspace: root, sessionPath });
        expect(await endpoint.release("pending")).toBeUndefined();
        expect(registry.find("pending")).toBeDefined();
        expect(existsSync(sessionPath)).toBe(false);

        await registry.renameSession("pending", "saved");
        expect(await endpoint.release("pending")).toHaveLength(1);
        expect(existsSync(sessionPath)).toBe(true);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a distributed trash close materializes the session before moving its artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-distributed-trash-"));
    const sessionPath = join(root, "pending.jsonl");
    const registry = createRegistry();
    try {
        const agent = await registry.create({ id: "pending", workspace: root, sessionPath });
        const entry = registry.agents.get(agent.id)!;
        entry.agent.close();
        await entry.run;
        const closed = await finishDistributedCloseMember(registry, agent.id, entry, "deleted");
        expect(closed?.id).toBe(agent.id);
        expect(existsSync(sessionPath)).toBe(true);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core the first prompt materializes a root conversation and it restores after owner restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-used-"));
    const sessionPath = join(root, "used.jsonl");
    let registry = createRegistry();
    try {
        const agent = await registry.create({
            id: "used",
            workspace: root,
            sessionPath,
        });
        expect(registry.agents.get(agent.id)!.store.isMaterialized()).toBe(false);
        expect(existsSync(sessionPath)).toBe(false);
        const attachment = agent.attach();
        await attachment.receive();
        attachment.send({ type: "prompt", content: "hello" });
        while ((await attachment.receive()).type !== "turn_finished") {}
        attachment.detach();

        expect(registry.agents.get(agent.id)!.store.isMaterialized()).toBe(true);
        expect(existsSync(sessionPath)).toBe(true);
        await registry.close();
        registry = createRegistry();
        const resumed = await registry.resume({ sessionPath });
        expect(resumed.id).toBe("used");
        expect(registry.agents.get(resumed.id)!.store.isMaterialized()).toBe(true);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core a pending root is absent after restart while an eager fork remains resumable", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-restart-"));
    const pendingPath = join(root, "pending.jsonl");
    const parentPath = join(root, "parent.jsonl");
    const forkPath = join(root, "fork.jsonl");
    let registry = createRegistry();
    try {
        await registry.create({ id: "pending", workspace: root, sessionPath: pendingPath });
        const parent = await registry.create({ id: "parent", workspace: root, sessionPath: parentPath });
        expect(existsSync(parentPath)).toBe(false);
        const childPath = join(root, "child.jsonl");
        await registry.createWithKind(
            { id: "child", workspace: root, sessionPath: childPath },
            "background",
            { parentId: parent.id, approvalMode: "auto" },
        );
        expect(existsSync(childPath)).toBe(true);
        const branched = await registry.branch({
            sourceId: parent.id,
            position: "at",
            id: "fork",
            sessionPath: forkPath,
            initialMessages: [{
                role: "user",
                content: [{ type: "text", text: "initial context" }],
            }],
        });
        expect(branched).toBeDefined();
        expect(existsSync(pendingPath)).toBe(false);
        expect(existsSync(forkPath)).toBe(true);
        expect((await SessionStore.open(forkPath)).messages()).toEqual([
            expect.objectContaining({ role: "user" }),
        ]);
        await registry.close();

        registry = createRegistry();
        expect(existsSync(pendingPath)).toBe(false);
        expect(await registry.resume({ sessionPath: forkPath })).toBeDefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a deferred create failure preserves a conflicting session path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-conflict-"));
    const sessionPath = join(root, "existing.jsonl");
    const marker = "pre-existing session data\n";
    await Bun.write(sessionPath, marker);
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        createToolHooks: () => { throw new Error("setup failed"); },
    });
    try {
        await expect(registry.create({
            id: "conflicting",
            workspace: root,
            sessionPath,
        })).rejects.toMatchObject({ code: "EEXIST" });
        expect(await Bun.file(sessionPath).text()).toBe(marker);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a file created during failed deferred setup is not removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-late-conflict-"));
    const sessionPath = join(root, "existing.jsonl");
    const marker = "created elsewhere\n";
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        createToolHooks: () => {
            writeFileSync(sessionPath, marker);
            throw new Error("setup failed");
        },
    });
    try {
        await expect(registry.create({ id: "pending", workspace: root, sessionPath })).rejects.toThrow("setup failed");
        expect(await Bun.file(sessionPath).text()).toBe(marker);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("hostless SessionStore creation remains eager", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-lazy-hostless-"));
    const sessionPath = join(root, "eager.jsonl");
    try {
        const store = await SessionStore.create(sessionPath, {
            sessionId: "eager",
            cwd: root,
        });
        expect(store.isMaterialized()).toBe(true);
        expect(existsSync(sessionPath)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
