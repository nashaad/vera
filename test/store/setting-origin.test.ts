import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionBranch } from "../../src/store/session-branch.ts";
import { SessionStore } from "../../src/store/session-store.ts";

async function store(name: string): Promise<SessionStore> {
    const root = await mkdtemp(join(tmpdir(), "vera-origin-"));
    return SessionStore.create(join(root, `${name}.jsonl`), {
        sessionId: name,
        cwd: root,
    });
}

test("a session with no record has no origin at all, which is not `user`", async () => {
    const session = await store("empty");
    expect(session.modelSettingsOrigin()).toBeUndefined();
    expect(session.modelSettingsHistory()).toEqual([]);
});

test("a record written without an origin reads as the user's own", async () => {
    const session = await store("legacy");
    await session.appendModelSettings({ model: "sol" });
    // Legacy sessions predate agents, so their setting was always deliberate.
    expect(session.modelSettingsOrigin()).toBe("user");
});

test("an origin survives being written, read back, and reopened", async () => {
    const session = await store("origins");
    await session.appendModelSettings({ model: "sol" }, "agent-default");
    await session.appendModelSettings({ model: "luna" }, "user");
    expect(session.modelSettingsOrigin()).toBe("user");

    const reopened = await SessionStore.open(session.path);
    expect(reopened.modelSettingsHistory().map((entry) => [
        entry.settings.model,
        entry.origin,
    ])).toEqual([["sol", "agent-default"], ["luna", "user"]]);
});

test("a permission record carries its origin too", async () => {
    const session = await store("posture");
    await session.appendApprovalMode("readonly", "agent-default");
    expect(session.approvalModeOrigin()).toBe("agent-default");
    await session.appendApprovalMode("auto");
    expect(session.approvalModeOrigin()).toBe("user");
});

test("branching carries the origin rather than flattening it to an override", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-origin-branch-"));
    const source = await SessionStore.create(join(root, "source.jsonl"), {
        sessionId: "source",
        cwd: root,
    });
    await source.appendModelSettings(
        { model: "sol", reasoningEffort: "low" },
        "agent-default",
    );
    await source.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
    });

    const branch = await createSessionBranch({
        source,
        destinationPath: join(root, "branch.jsonl"),
        sessionId: "branch",
        position: "at",
    });

    expect(branch.store.modelSettings()).toEqual({
        model: "sol",
        reasoningEffort: "low",
    });
    // Without this the branch would show an override marker for a pair nobody
    // ever dialed, and selecting another agent would not move off it.
    expect(branch.store.modelSettingsOrigin()).toBe("agent-default");
});
