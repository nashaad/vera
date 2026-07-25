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
    type PermissionGrant,
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

function grant(id: string, executable: string): PermissionGrant {
    return {
        id,
        kind: "command",
        when: { tool: "bash", executable },
        scope: "session",
        lifetime: "session",
    };
}

function inspection(
    grants: readonly PermissionGrant[],
    preferences: readonly PermissionPreference[],
): PermissionInspection {
    // `ask` is a built-in mode, so the inspection is always defined here.
    return inspectPermissions("ask", {}, grants, preferences)!;
}

test("both tiers are listed, grants first, under their own headings", () => {
    const state = startTuiPreferencesList(
        inspection([grant("g1", "curl")], [preference("p1", "git")]),
    );
    expect(state.entries).toEqual([
        { kind: "grant", id: "g1", when: { tool: "bash", executable: "curl" } },
        {
            kind: "preference",
            id: "p1",
            when: { tool: "bash", executable: "git" },
        },
    ]);
    // The predicate is shown, not the ID: an opaque ID identifies nothing to a
    // reader, and removal targets the highlighted row so no ID is ever typed.
    // The lifetime is spelled out, because that is the difference between the
    // two sections and it decides whether revoking is worth doing.
    expect(renderTuiPreferencesList(state)).toBe([
        "Session grants (expire when this session ends)",
        "> tool=bash, executable=curl",
        "Durable preferences (kept across sessions)",
        "  tool=bash, executable=git",
    ].join("\n"));
});

test("a section with nothing in it prints no heading", () => {
    const state = startTuiPreferencesList(
        inspection([], [preference("p1", "git")]),
    );
    expect(renderTuiPreferencesList(state)).toBe([
        "Durable preferences (kept across sessions)",
        "> tool=bash, executable=git",
    ].join("\n"));
});

test("an empty list says how to create one", () => {
    const state = startTuiPreferencesList(inspection([], []));
    expect(renderTuiPreferencesList(state)).toContain(
        "Answer an approval with 2 or 4",
    );
});

test("a missing inspection is an empty list rather than a crash", () => {
    expect(startTuiPreferencesList(undefined).entries).toEqual([]);
});

test("arrows move the highlight across both sections and stop at the ends", () => {
    let state = startTuiPreferencesList(
        inspection([grant("g1", "curl")], [preference("p1", "git")]),
    );
    expect(handleTuiPreferencesListKey(state, { name: "up" }).state)
        .toMatchObject({ selectedIndex: 0 });
    // One keypress crosses the section boundary: the headings are decoration the
    // cursor never lands on.
    state = handleTuiPreferencesListKey(state, { name: "down" }).state!;
    expect(state.entries[state.selectedIndex]?.kind).toBe("preference");
    expect(handleTuiPreferencesListKey(state, { name: "down" }).state)
        .toMatchObject({ selectedIndex: 1 });
});

test("delete carries the row's kind, which picks the removal command", () => {
    const state = startTuiPreferencesList(
        inspection([grant("g1", "curl")], [preference("p1", "git")]),
    );
    expect(handleTuiPreferencesListKey(state, { name: "delete" }).remove)
        .toMatchObject({ kind: "grant", id: "g1" });

    const onPreference = handleTuiPreferencesListKey(state, { name: "down" })
        .state!;
    const transition = handleTuiPreferencesListKey(onPreference, {
        name: "delete",
    });
    expect(transition.remove).toMatchObject({ kind: "preference", id: "p1" });
    // No confirmation step: the overlay stays open and the row is still there
    // until the engine's refreshed inspection says otherwise.
    expect(transition.state).toBe(onPreference);
    expect(transition.handled).toBe(true);
});

test("delete on an empty list is a no-op, not a crash", () => {
    const state = startTuiPreferencesList(inspection([], []));
    const transition = handleTuiPreferencesListKey(state, { name: "delete" });
    expect(transition.remove).toBeUndefined();
    expect(transition.handled).toBe(true);
});

test("escape closes and modified keys fall through to the client", () => {
    const state = startTuiPreferencesList(
        inspection([], [preference("p1", "curl")]),
    );
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
        inspection(
            [grant("g1", "curl")],
            [preference("p1", "git"), preference("p2", "rm")],
        ),
    );
    state = handleTuiPreferencesListKey(state, { name: "down" }).state!;
    state = handleTuiPreferencesListKey(state, { name: "down" }).state!;
    expect(state.selectedIndex).toBe(2);

    // The engine answered a removal with a full inspection, so the list is taken
    // from it rather than patched locally.
    state = syncTuiPreferencesList(state, inspection([grant("g1", "curl")], []));
    expect(state.entries).toHaveLength(1);
    expect(state.selectedIndex).toBe(0);
});

test("clamping survives the list emptying completely", () => {
    let state = startTuiPreferencesList(
        inspection([], [preference("p1", "curl")]),
    );
    state = syncTuiPreferencesList(state, inspection([], []));
    expect(state.entries).toEqual([]);
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
        let state = startTuiPreferencesList(inspection([], many));
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

test("the heading follows the window rather than scrolling away with row zero", async () => {
    // A section heading is emitted when the window's first visible row starts a
    // new group, not only at the real start of the group. Without that, scrolling
    // past the top of a section leaves its rows unlabeled.
    const setup = await createTestRenderer({ width: 60, height: 20 });
    const view = createTuiPreferencesListView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    try {
        const grants = Array.from(
            { length: 15 },
            (_unused, index) => grant(`g${index}`, `tool${index}`),
        );
        let state = startTuiPreferencesList(inspection(grants, []));
        for (let step = 0; step < 14; step += 1) {
            state = handleTuiPreferencesListKey(state, { name: "down" }).state!;
        }
        view.update(state);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("executable=tool14");
        expect(frame).toContain("Session grants");
    } finally {
        setup.renderer.destroy();
    }
});
