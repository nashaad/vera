import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextSizeTriggerEvent } from "../../src/engine/events.ts";
import { contextSizeTriggerPayload } from "../../src/host/agent-registry/context-size-trigger.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const triggered: ContextSizeTriggerEvent = {
    type: "context_size_trigger",
    reason: "pressure",
    policy: { id: "trim", kind: "every_n" },
    actions: ["trim"],
    tokens: 132_000,
    tokensAfter: 118_000,
    capacity: 200_000,
};

async function store(parentId?: string): Promise<SessionStore> {
    const directory = mkdtempSync(join(tmpdir(), "vera-context-size-trigger-"));
    directories.push(directory);
    return SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: parentId === undefined ? "ship" : "lookout",
        cwd: directory,
        ...(parentId === undefined ? {} : { parentId }),
    });
}

test("a fired trigger becomes a context_size_trigger payload", async () => {
    const ship = await store();
    expect(contextSizeTriggerPayload(ship, triggered)).toEqual({
        type: "context_size_trigger",
        sessionId: "ship",
        workspace: ship.header.cwd,
        reason: "pressure",
        policy: { id: "trim", kind: "every_n" },
        actions: ["trim"],
        tokens: 132_000,
        tokensAfter: 118_000,
        capacity: 200_000,
        spawned: false,
    });
    const { capacity: _capacity, policy: _policy, ...bare } = triggered;
    const payload = contextSizeTriggerPayload(ship, bare);
    expect(payload).not.toHaveProperty("capacity");
    expect(payload).not.toHaveProperty("policy");
});

test("a subagent's trigger is marked spawned", async () => {
    const lookout = await store("ship");
    expect(contextSizeTriggerPayload(lookout, triggered).spawned).toBe(true);
});

test("a trigger without a policy carries no threshold facts", async () => {
    const ship = await store();
    const payload = contextSizeTriggerPayload(ship, {
        type: "context_size_trigger",
        reason: "session_start",
        actions: [],
        tokens: 12_000,
        tokensAfter: 12_000,
    });
    expect(payload.reason).toBe("session_start");
    expect(payload.actions).toEqual([]);
    expect(payload).not.toHaveProperty("policy");
    expect(payload).not.toHaveProperty("capacity");
});
