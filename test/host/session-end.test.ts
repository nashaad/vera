import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionEndPayload } from "../../src/host/agent-registry/session-end.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

async function store(parentId?: string): Promise<SessionStore> {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-end-"));
    directories.push(directory);
    return SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: parentId === undefined ? "ship" : "lookout",
        cwd: directory,
        ...(parentId === undefined ? {} : { parentId }),
    });
}

function user(text: string, extra: Record<string, unknown> = {}) {
    return { role: "user" as const, content: [{ type: "text" as const, text }], ...extra };
}

test("turns count prompts, not context or messages that joined a turn", async () => {
    const ship = await store();
    await ship.appendMessage(user("find the treasure"));
    await ship.appendMessage(user("and the map", { arrivedDuringTurn: true }));
    await ship.appendMessage(user("Rules of the ship", { contextSource: "session_start", internal: true }));
    await ship.appendMessage(user("dig"));

    expect(sessionEndPayload(ship, "detached")).toEqual({
        type: "session_end",
        sessionId: "ship",
        workspace: ship.header.cwd,
        reason: "detached",
        turns: 2,
        spawned: false,
    });
});

test("a session another agent started is spawned", async () => {
    const lookout = await store("ship");
    expect(sessionEndPayload(lookout, "closed")).toMatchObject({
        sessionId: "lookout",
        turns: 0,
        spawned: true,
    });
});
