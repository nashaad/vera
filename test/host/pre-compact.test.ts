import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompactionUpdate } from "../../src/engine/protocol.ts";
import { preCompactPayload } from "../../src/host/agent-registry/pre-compact.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const started: CompactionUpdate = {
    type: "compaction",
    phase: "started",
    strategy: "full-summary",
    trigger: "manual",
    tokens: 182_000,
    capacity: 200_000,
    seq: 3,
};

async function store(parentId?: string): Promise<SessionStore> {
    const directory = mkdtempSync(join(tmpdir(), "vera-pre-compact-"));
    directories.push(directory);
    return SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: parentId === undefined ? "ship" : "lookout",
        cwd: directory,
        ...(parentId === undefined ? {} : { parentId }),
    });
}

test("a started compaction becomes a pre_compact payload", async () => {
    const ship = await store();
    expect(preCompactPayload(ship, started)).toEqual({
        type: "pre_compact",
        sessionId: "ship",
        workspace: ship.header.cwd,
        reason: "manual",
        tokens: 182_000,
        capacity: 200_000,
        spawned: false,
    });
    const { capacity: _capacity, ...unknownWindow } = started;
    expect(preCompactPayload(ship, unknownWindow)).not.toHaveProperty("capacity");
});

test("a subagent's compaction is marked spawned", async () => {
    const lookout = await store("ship");
    expect(preCompactPayload(lookout, started)?.spawned).toBe(true);
});

test("a finished compaction is not a pre_compact", async () => {
    const ship = await store();
    expect(preCompactPayload(ship, {
        type: "compaction",
        phase: "finished",
        strategy: "full-summary",
        outcome: "compacted",
        seq: 4,
    })).toBeUndefined();
});
