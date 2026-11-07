import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blockSessionThroughHost, unblockSessionThroughHost } from "../../src/host/session-block-client.ts";
import { startHostServer } from "../../src/host/server.ts";
import { createSessionBlockService } from "../../src/host/session-block-service.ts";
import { ResidentAgent, SessionBlockedError } from "../../src/host/resident-agent.ts";
import {
    isSessionBlockedSync,
    listSessionBlocks,
    readSessionBlock,
    removeSessionBlock,
    startedTreeOf,
    writeSessionBlock,
} from "../../src/host/session-block.ts";

const NOW = new Date("2026-11-07T10:00:00.000Z");

function record(sessionId: string, root: string, reason: string | null = null) {
    return {
        version: 1 as const,
        session_id: sessionId,
        root_session_id: root,
        blocked_at: NOW.toISOString(),
        reason,
    };
}

test("startedTreeOf walks the started-by relation breadth first from the root", () => {
    const parents = new Map([
        ["b", "a"],
        ["c", "a"],
        ["d", "b"],
        ["e", "x"],
    ]);
    expect(startedTreeOf("a", parents)).toEqual(["a", "b", "c", "d"]);
});

test("a second block does not rewrite the first block record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-block-flags-"));
    try {
        expect(await writeSessionBlock(dir, record("s1", "s1", "first"))).toBe("written");
        expect(await writeSessionBlock(dir, record("s1", "s2", "second"))).toBe("already_blocked");
        const state = await readSessionBlock(dir, "s1");
        expect(state).toEqual({ status: "blocked", record: record("s1", "s1", "first") });
        expect(isSessionBlockedSync(dir, "s1")).toBe(true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("an unreadable block file still blocks and is listed by id only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-block-corrupt-"));
    try {
        await writeSessionBlock(dir, record("ok", "ok"));
        await writeFile(join(dir, "broken.json"), "{not json");
        expect(isSessionBlockedSync(dir, "broken")).toBe(true);
        expect(await readSessionBlock(dir, "broken")).toEqual({ status: "unreadable" });
        expect((await listSessionBlocks(dir)).map((entry) => entry.session_id)).toEqual(["ok"]);
        expect(await removeSessionBlock(dir, "broken")).toBe(true);
        expect(isSessionBlockedSync(dir, "broken")).toBe(false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("block aborts the live tree before and after writing flags, and keeps sessions open", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-block-service-"));
    const blockedDirectory = join(root, "blocked");
    const sessionDirectory = join(root, "sessions");
    const aborts: string[] = [];
    const fakeAgent = (id: string) => ({
        abort: () => aborts.push(id),
    });
    const registry = {
        agents: new Map([
            ["parent", { parentId: undefined, agent: fakeAgent("parent") }],
            ["child", { parentId: "parent", agent: fakeAgent("child") }],
        ]),
    };
    const service = createSessionBlockService({
        registry: registry as never,
        sessionDirectory,
        blockedDirectory,
        now: () => NOW,
    });
    try {
        const outcome = await service.block({
            target_agent_id: "parent",
            session_ids: ["parent", "child"],
            reason: "stuck",
        } as never);
        expect(outcome).toEqual({ status: "blocked", sessionIds: ["parent", "child"] });
        expect(isSessionBlockedSync(blockedDirectory, "parent")).toBe(true);
        expect(isSessionBlockedSync(blockedDirectory, "child")).toBe(true);
        expect(aborts).toEqual(["parent", "child", "parent", "child"]);
        expect(await readFile(join(blockedDirectory, "child.json"), "utf8")).toContain('"reason": "stuck"');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a blocked resident agent refuses new prompts and queued delivery, and abort still reaches it", async () => {
    let blocked: string | undefined;
    const agent = new ResidentAgent("agent-1", "/work/one", {
        turnStartRefusal: () => blocked,
    });
    try {
        blocked = "Session agent-1 is blocked. Nothing new runs in it until 'vera unblock agent-1'.";
        expect(() => agent.sendPrompt("hello")).toThrow(SessionBlockedError);
        agent.triggerDeliveryTurn();
        agent.abort();
        expect(await agent.engine.receive()).toEqual({ type: "abort" });
        blocked = undefined;
        agent.sendPrompt("again");
        expect(await agent.engine.receive()).toEqual({ type: "prompt", content: "again" } as never);
    } finally {
        agent.close();
    }
});

test("block and unblock over the host socket abort the live session and gate its turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-block-wire-"));
    const blockedDirectory = join(root, "blocked");
    const agent = new ResidentAgent("agent-1", "/work/one", {
        turnStartRefusal: () => (isSessionBlockedSync(blockedDirectory, "agent-1")
            ? "blocked"
            : undefined),
    });
    const registry = {
        agents: new Map([["agent-1", { parentId: undefined, agent }]]),
    };
    const service = createSessionBlockService({
        registry: registry as never,
        sessionDirectory: join(root, "sessions"),
        blockedDirectory,
    });
    const server = await startHostServer({
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        findAgent: () => agent,
        blockSession: service.block,
        unblockSession: service.unblock,
    });
    try {
        const abort = agent.engine.receive();
        const outcome = await blockSessionThroughHost(server.socketPath, {
            targetAgentId: "agent-1",
            sessionIds: ["agent-1"],
            reason: "loop",
        });
        expect(outcome).toEqual({ status: "blocked", sessionIds: ["agent-1"] });
        expect(await abort).toEqual({ type: "abort" });
        expect(isSessionBlockedSync(blockedDirectory, "agent-1")).toBe(true);
        expect(() => agent.sendPrompt("hi")).toThrow(SessionBlockedError);
        expect(agent.closed).toBe(false);

        const cleared = await unblockSessionThroughHost(server.socketPath, {
            targetAgentId: "agent-1",
            sessionIds: ["agent-1"],
        });
        expect(cleared).toEqual({ status: "unblocked", sessionIds: ["agent-1"] });
        expect(isSessionBlockedSync(blockedDirectory, "agent-1")).toBe(false);
    } finally {
        agent.close();
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
});
