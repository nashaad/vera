import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiPreferencesListView,
    handleTuiPreferencesListKey,
    renderTuiPreferencesList,
    startTuiPreferencesList,
    syncTuiPreferencesList,
} from "../../clients/tui/preferences-list.ts";
import {
    inspectPermissions,
    type PermissionInspection,
    type PermissionPreference,
} from "../../src/engine/permissions.ts";

function preference(id: string, executable: string): PermissionPreference {
    return {
        id,
        when: { tool: "bash", executable },
        createdAt: "2026-07-25T00:00:00.000Z",
    };
}

function inspection(
    preferences: readonly PermissionPreference[],
): PermissionInspection {
    // `ask` is a built-in mode, so the inspection is always defined here.
    return inspectPermissions("ask", {}, [], preferences)!;
}

test("the list opens on the durable preferences the client already has", () => {
    const state = startTuiPreferencesList(
        inspection([preference("a", "curl"), preference("b", "git")]),
    );
    expect(state.preferences).toHaveLength(2);
    expect(state.selectedIndex).toBe(0);
    // The predicate is shown, not the ID: a UUID identifies nothing to a
    // reader, and removal targets the highlighted row so no ID is ever typed.
    expect(renderTuiPreferencesList(state)).toBe([
        "> tool=bash, executable=curl",
        "  tool=bash, executable=git",
    ].join("\n"));
});

test("an empty list says how to create one", () => {
    const state = startTuiPreferencesList(inspection([]));
    expect(renderTuiPreferencesList(state)).toContain("Answer an approval with 4");
});

test("a missing inspection is an empty list rather than a crash", () => {
    expect(startTuiPreferencesList(undefined).preferences).toEqual([]);
});

test("arrows move the highlight and stop at both ends", () => {
    let state = startTuiPreferencesList(
        inspection([preference("a", "curl"), preference("b", "git")]),
    );
    expect(handleTuiPreferencesListKey(state, { name: "up" }).state)
        .toMatchObject({ selectedIndex: 0 });
    state = handleTuiPreferencesListKey(state, { name: "down" }).state!;
    expect(state.selectedIndex).toBe(1);
    expect(handleTuiPreferencesListKey(state, { name: "down" }).state)
        .toMatchObject({ selectedIndex: 1 });
});

test("delete asks to remove the highlighted preference and nothing else", () => {
    const state = handleTuiPreferencesListKey(
        startTuiPreferencesList(
            inspection([preference("a", "curl"), preference("b", "git")]),
        ),
        { name: "down" },
    ).state!;
    const transition = handleTuiPreferencesListKey(state, { name: "delete" });
    expect(transition.removeId).toBe("b");
    // No confirmation step: the overlay stays open and the row is still there
    // until the engine's refreshed inspection says otherwise.
    expect(transition.state).toBe(state);
    expect(transition.handled).toBe(true);
});

test("delete on an empty list is a no-op, not a crash", () => {
    const state = startTuiPreferencesList(inspection([]));
    const transition = handleTuiPreferencesListKey(state, { name: "delete" });
    expect(transition.removeId).toBeUndefined();
    expect(transition.handled).toBe(true);
});

test("escape closes and modified keys fall through to the client", () => {
    const state = startTuiPreferencesList(inspection([preference("a", "curl")]));
    expect(handleTuiPreferencesListKey(state, { name: "escape" }).state)
        .toBeUndefined();
    // Ctrl+C must reach the client's interrupt handling rather than being eaten
    // by the overlay.
    expect(handleTuiPreferencesListKey(state, { name: "c", ctrl: true }).handled)
        .toBe(false);
    expect(handleTuiPreferencesListKey(state, { name: "x" }).handled).toBe(false);
});

test("a refreshed inspection replaces the list and clamps the cursor", () => {
    let state = startTuiPreferencesList(
        inspection([
            preference("a", "curl"),
            preference("b", "git"),
            preference("c", "rm"),
        ]),
    );
    state = handleTuiPreferencesListKey(state, { name: "down" }).state!;
    state = handleTuiPreferencesListKey(state, { name: "down" }).state!;
    expect(state.selectedIndex).toBe(2);

    // The engine answered a removal with a full inspection, so the list is
    // taken from it rather than patched locally.
    state = syncTuiPreferencesList(state, inspection([preference("a", "curl")]));
    expect(state.preferences).toHaveLength(1);
    expect(state.selectedIndex).toBe(0);
});

test("clamping survives the list emptying completely", () => {
    let state = startTuiPreferencesList(inspection([preference("a", "curl")]));
    state = syncTuiPreferencesList(state, inspection([]));
    expect(state.preferences).toEqual([]);
    // Not -1, which would index nowhere and make the next delete throw.
    expect(state.selectedIndex).toBe(0);
});

test("a list longer than the window keeps the footer and the cursor on screen", async () => {
    const many = Array.from(
        { length: 25 },
        (_unused, index) => preference(`p${index}`, `tool${index}`),
    );
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiPreferencesListView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    try {
        let state = startTuiPreferencesList(inspection(many));
        view.update(state);
        await setup.flush();
        let frame = setup.captureCharFrame();
        // Windowed to the first ten of 25, so the eleventh is not rendered.
        expect(frame).toContain("executable=tool9");
        expect(frame).not.toContain("executable=tool10");
        expect(frame).toContain("[esc] close");

        // Walk to the end. The window has to follow, or delete would target a
        // row the user cannot see.
        for (let step = 0; step < 24; step += 1) {
            state = handleTuiPreferencesListKey(state, { name: "down" }).state!;
        }
        expect(state.selectedIndex).toBe(24);
        view.update(state);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("> tool=bash, executable=tool24");
        // The window slid: the last ten rows are 15 through 24, so 14 is gone.
        expect(frame).toContain("executable=tool15");
        expect(frame).not.toContain("executable=tool14");
        expect(frame).toContain("[esc] close");
    } finally {
        setup.renderer.destroy();
    }
});
