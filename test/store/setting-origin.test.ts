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
    expect(await session.readModelSettingsHistory()).toEqual([]);
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
    expect((await reopened.readModelSettingsHistory()).map((entry) => [
        entry.settings.model,
        entry.origin,
    ])).toEqual([["sol", "agent-default"], ["luna", "user"]]);
    await reopened.appendModelSettings({ model: "next" }, "user");
    expect((await reopened.readModelSettingsHistory()).map((entry) => entry.settings.model)).toEqual(["sol", "luna", "next"]);
});

test("a permission record carries its origin too", async () => {
    const session = await store("posture");
    await session.appendApprovalMode("readonly", "agent-default");
    expect(session.approvalModeOrigin()).toBe("agent-default");
    await session.appendApprovalMode("auto");
    expect(session.approvalModeOrigin()).toBe("user");
});

test("only the latest setting facts stay resident and older records remain readable", async () => {
    const session = await store("settings-residency");
    await session.appendModelSettings({ model: "first" });
    await session.appendModelSettings({ model: "second" });
    await session.appendApprovalMode("readonly");
    await session.appendApprovalMode("auto");
    await session.appendName("first name");
    await session.appendName(null);
    await session.appendSelectedAgent("first", { name: "first", instructions: "first", tools: [] });
    await session.appendSelectedAgent("second", { name: "second", instructions: "second", tools: [] });
    for (const current of [session, await SessionStore.open(session.path)]) {
        const state = Reflect.get(current, "projection") as {
            modelSettingsEntries: unknown[]; permissionsEntries: unknown[]; nameEntries: unknown[]; selectedAgentEntries: unknown[];
        };
        expect(state.modelSettingsEntries).toHaveLength(1);
        expect(state.permissionsEntries).toHaveLength(1);
        expect(state.nameEntries).toHaveLength(1);
        expect(state.selectedAgentEntries).toHaveLength(1);
        expect((await current.readModelSettingsHistory()).map((entry) => entry.settings.model)).toEqual(["first", "second"]);
        const permissions = [];
        for await (const { record } of current.walkRecords("permissions")) permissions.push(record.mode);
        expect(permissions).toEqual(["readonly", "auto"]);
        const names = [];
        for await (const { record } of current.walkRecords("session_name")) names.push(record.name);
        expect(names).toEqual(["first name", null]);
        const selections = [];
        for await (const { record } of current.walkRecords("agent_select")) selections.push(record.name);
        expect(selections).toEqual(["first", "second"]);
    }
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
