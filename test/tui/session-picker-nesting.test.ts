import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerKey,
    startTuiSessionPicker,
    updateTuiSettingsPickerSearch,
} from "../../clients/tui/settings-picker.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

const now = new Date("2026-07-20T21:00:00.000Z");

function session(
    id: string,
    extra: Partial<RegisteredAgentSummary> = {},
): RegisteredAgentSummary {
    return {
        id,
        workspace: "/work/vera",
        session_path: `/sessions/${id}.jsonl`,
        kind: "interactive",
        status: "idle",
        live: false,
        title: id,
        updated_at: "2026-07-20T20:00:00.000Z",
        ...extra,
    };
}

async function frame(state: ReturnType<typeof startTuiSessionPicker>, width: number, height: number): Promise<string> {
    const setup = await createTestRenderer({ width, height });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        view.update(state);
        await setup.flush();
        return setup.captureCharFrame();
    } finally {
        setup.renderer.destroy();
    }
}

test("@core completed subagents follow their active parent and remain selectable", async () => {
    const state = startTuiSessionPicker([
        session("unrelated", { live: true, updated_at: "2026-07-20T20:55:00.000Z" }),
        session("parent", { status: "working", live: true, title: "Sail the brig" }),
        session("child", { kind: "background", status: "completed", parent_id: "parent", title: "Polish the anchor", updated_at: "2026-07-20T20:30:00.000Z" }),
        session("child-two", { kind: "background", status: "completed", parent_id: "parent", title: "Raise the sails", updated_at: "2026-07-20T20:20:00.000Z" }),
        session("grandchild", { kind: "background", parent_id: "child", title: "Count the ropes" }),
    ], "parent", false, now);

    const rows = state.options.filter((option) => option.section === undefined);
    expect(rows.map((row) => row.sessionId)).toEqual(["parent", "child", "grandchild", "child-two", "unrelated"]);
    expect(rows.filter((row) => row.group === "IDLE").map((row) => row.sessionId)).toEqual(["unrelated"]);
    expect(rows.slice(0, 4).map((row) => row.group)).toEqual(["ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE"]);
    expect(rows[1]).toMatchObject({ label: "sub: Polish the anchor", activity: "completed", depth: 1, sessionWorking: false });
    expect(rows[2]).toMatchObject({ label: "sub: Count the ropes", depth: 2 });
    expect(rows[3]).toMatchObject({ label: "sub: Raise the sails", activity: "completed", depth: 1, sessionWorking: false });
    const lines = (await frame(state, 120, 36)).split("\n");
    const parent = lines.findIndex((line) => line.includes("Sail the brig"));
    const child = lines.findIndex((line) => line.includes("Polish the anchor"));
    expect(parent).toBeGreaterThan(0);
    expect(child).toBe(parent + 1);
    expect(lines[child]).toContain("completed");
    expect(lines[child]).toContain("└");
    expect(lines[child]!.indexOf("sub: Polish")).toBeGreaterThan(lines[parent]!.indexOf("Sail the brig"));
    const secondChild = lines.findIndex((line) => line.includes("Raise the sails"));
    expect(secondChild).toBeGreaterThan(child);
    expect(lines[secondChild]).toContain("└");
    expect(lines[secondChild]).toContain("completed");
    const selected = handleTuiSettingsPickerKey(state, { name: "down" }).state!;
    expect(selected.options[selected.selectedIndex]?.sessionId).toBe("child");
    const preview = handleTuiSettingsPickerKey(selected, { name: "space" });
    expect(preview.state?.kind).toBe("session_preview");
    expect(preview.previewSession).toEqual({ path: "/sessions/child.jsonl" });
    expect(handleTuiSettingsPickerKey(preview.state!, { name: "escape" }).state).toBe(selected);
    const narrow = await frame(selected, 80, 24);
    expect(narrow).toContain("completed");
    expect(narrow).toContain("sub: Polish the anchor");
    const leave = handleTuiSettingsPickerKey(selected, { name: "enter" }).state!;
    expect(leave.kind).toBe("session_leave");
    expect(handleTuiSettingsPickerKey(leave, { name: "enter" }).selection).toMatchObject({
        kind: "session", sessionId: "child", sessionPath: "/sessions/child.jsonl",
    });
    const searched = updateTuiSettingsPickerSearch(state, "Polish").state!;
    expect(searched.options.filter((option) => option.section === undefined).map((option) => option.sessionId)).toEqual(["child"]);
    expect((await frame(searched, 80, 24)).split("\n").find((line) => line.includes("Polish"))).not.toContain("└");
    const searchedLeave = handleTuiSettingsPickerKey(searched, { name: "enter" }).state!;
    expect(handleTuiSettingsPickerKey(searchedLeave, { name: "enter" }).selection).toMatchObject({
        kind: "session", sessionId: "child", sessionPath: "/sessions/child.jsonl",
    });
});

test("only working sessions shimmer regardless of their parent's group", async () => {
    const state = startTuiSessionPicker([
        session("active-parent", { status: "working", live: true, title: "Sail the brig" }),
        session("finished-child", { kind: "background", status: "completed", parent_id: "active-parent", title: "Polish the anchor" }),
        session("idle-parent", { live: true, title: "Dry dock" }),
        session("working-child", { kind: "background", status: "working", live: true, parent_id: "idle-parent", title: "Scrub the deck" }),
    ], undefined, false, now);
    const setup = await createTestRenderer({ width: 120, height: 40 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        view.update(state);
        await setup.flush();
        const seen = new Map<string, Set<string>>([
            ["Sail the brig", new Set()],
            ["sub: Polish the anchor", new Set()],
            ["sub: Scrub the deck", new Set()],
        ]);
        for (let tick = 0; tick <= 70; tick += 10) {
            view.animateSessionTitles(tick, true);
            await setup.flush();
            const lines = setup.captureCharFrame().split("\n");
            const spans = setup.captureSpans().lines;
            for (const [title, frames] of seen) {
                const y = lines.findIndex((line) => line.includes(title));
                expect(y).toBeGreaterThanOrEqual(0);
                const x = lines[y]!.indexOf(title);
                const colors = spans[y]!.spans.flatMap((span) =>
                    Array.from(span.text, () => span.fg.toInts()));
                frames.add(JSON.stringify(colors.slice(x, x + title.length)));
            }
        }
        expect(seen.get("Sail the brig")!.size).toBeGreaterThan(1);
        expect(seen.get("sub: Polish the anchor")!.size).toBe(1);
        expect(seen.get("sub: Scrub the deck")!.size).toBeGreaterThan(1);
    } finally {
        setup.renderer.destroy();
    }
});

test("subagents follow parents in every section and orphans retain their own section", () => {
    const state = startTuiSessionPicker([
        session("waiting-parent", { status: "waiting", live: true }),
        session("waiting-child", { kind: "background", status: "completed", parent_id: "waiting-parent" }),
        session("idle-parent", { live: true }),
        session("idle-child", { kind: "background", status: "working", live: true, parent_id: "idle-parent" }),
        session("recent-parent"),
        session("recent-child", { kind: "background", status: "waiting", live: true, parent_id: "recent-parent" }),
        session("orphan", { kind: "background", status: "completed", parent_id: "missing" }),
    ], undefined, false, now);
    const rows = state.options.filter((option) => option.section === undefined);
    expect(rows.map((row) => [row.sessionId, row.group, row.depth ?? 0])).toEqual([
        ["waiting-parent", "NEEDS YOU", 0], ["waiting-child", "NEEDS YOU", 1],
        ["idle-parent", "IDLE", 0], ["idle-child", "IDLE", 1],
        ["recent-parent", "RECENT", 0], ["recent-child", "RECENT", 1],
        ["orphan", "RECENT", 0],
    ]);
    expect(rows.find((row) => row.sessionId === "idle-child")).toMatchObject({ activity: "working", sessionWorking: true });
    expect(rows.find((row) => row.sessionId === "recent-child")?.activity).toBe("waiting");
    expect(rows.find((row) => row.sessionId === "orphan")?.activity).toBe("completed");
});
