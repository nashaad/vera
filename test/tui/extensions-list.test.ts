import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import type { ExtensionListEntry } from "../../src/extensions/manager.ts";
import {
    createTuiExtensionsListView,
    extensionContributionLine,
    handleTuiExtensionsListKey,
    openTuiExtensionsList,
    openTuiExtensionsListError,
    renderTuiExtensionsList,
    syncTuiExtensionsList,
    type TuiExtensionsListState,
} from "../../clients/tui/extensions-list.ts";

function entry(
    overrides: Partial<ExtensionListEntry> & Pick<ExtensionListEntry, "id">,
): ExtensionListEntry {
    return {
        scope: "profile",
        enabled: true,
        managed: true,
        path: `/managed/${overrides.id}`,
        version: "0.1.0",
        capabilities: ["client.commands.register", "client.experimental_tui"],
        ...overrides,
    };
}

function key(
    state: TuiExtensionsListState,
    name: string,
    sequence?: string,
): TuiExtensionsListState {
    const transition = handleTuiExtensionsListKey(state, {
        name,
        ...(sequence === undefined ? {} : { sequence }),
    });
    expect(transition.handled).toBe(true);
    if (transition.state === undefined) throw new Error("overlay closed");
    return transition.state;
}

test("contribution labels drop the client API prefix", () => {
    expect(extensionContributionLine([
        "client.commands.register",
        "client.context.read",
        "client.experimental_tui",
        "client.sessions.read",
        "client.agents",
    ])).toBe("commands · context · tui · sessions · agents");
});

test("the empty list is explicit and still names install", () => {
    expect(renderTuiExtensionsList(openTuiExtensionsList([]))).toBe([
        "Extensions",
        "",
        "No extensions installed",
        "/extension install <path>  adds a local copy",
        "",
        "esc close",
    ].join("\n"));
});

test("the list groups project above profile and carries status in words", () => {
    let state = openTuiExtensionsList([
        entry({
            id: "example.context",
            capabilities: [
                "client.commands.register",
                "client.context.read",
                "client.experimental_tui",
                "client.sessions.read",
            ],
        }),
        entry({
            id: "vera.btw",
            version: "1.2.0",
            capabilities: [
                "client.commands.register",
                "client.agents",
                "client.ui.sidebar",
                "client.ui.mentions",
                "client.keybindings.register",
            ],
        }),
        entry({
            id: "vera.btw",
            scope: "project",
            version: "1.2.0",
            path: "/project/.vera/extensions/vera.btw",
            capabilities: ["client.agents"],
        }),
    ]);
    expect(renderTuiExtensionsList(state)).toBe([
        "Extensions",
        "",
        "In Project",
        "› vera.btw         v1.2.0  enabled",
        "  agents",
        "",
        "In Profile",
        "  example.context  v0.1.0  enabled",
        "  commands · context · tui · sessions",
        "  vera.btw         v1.2.0  shadowed",
        "  commands · agents · sidebar · mentions · keys",
        "",
        "↑↓ move · ⏎ details · Space disable · esc close",
    ].join("\n"));
    state = key(state, "down");
    expect(renderTuiExtensionsList(state)).toContain(
        "› example.context  v0.1.0  enabled",
    );
});

test("failed and unmanaged rows keep the status word without a toggle", () => {
    const failed = openTuiExtensionsList([
        entry({
            id: "broken.ext",
            error: "missing entrypoint",
            capabilities: undefined,
        }),
    ]);
    expect(renderTuiExtensionsList(failed)).toContain("v0.1.0  failed");
    expect(renderTuiExtensionsList(failed)).toContain("missing entrypoint");
    expect(handleTuiExtensionsListKey(failed, { name: "space", sequence: " " }))
        .toEqual({
            state: failed,
            handled: true,
            mutate: {
                operation: "disable",
                entry: failed.rows[0]!,
            },
        });

    const unmanaged = openTuiExtensionsList([
        entry({
            id: "hand.ext",
            managed: false,
            source: undefined,
        }),
    ]);
    expect(renderTuiExtensionsList(unmanaged)).toContain("unmanaged");
    expect(renderTuiExtensionsList(unmanaged)).toContain(
        "↑↓ move · ⏎ details · esc close",
    );
    expect(handleTuiExtensionsListKey(unmanaged, { name: "space", sequence: " " }))
        .toEqual({ state: unmanaged, handled: true });
});

test("Enter opens details, Space from the list asks to disable, Escape closes", () => {
    let state = openTuiExtensionsList([
        entry({ id: "example.context" }),
    ], new Set(["example.context"]));
    state = key(state, "enter");
    const rendered = renderTuiExtensionsList(state);
    expect(rendered).toContain("example.context");
    expect(rendered).toContain("v0.1.0 · enabled · profile");
    expect(rendered).toContain("loaded on this client");
    expect(rendered).toContain("commands · tui");
    expect(rendered).toContain("client.commands.register, client.experimental_tui");
    expect(rendered).toContain("› Disable");
    expect(rendered).toContain("  Remove");
    expect(rendered).not.toContain("digest");
    expect(rendered).toContain("↑↓ move · ⏎ disable · esc back");

    const toggle = handleTuiExtensionsListKey(openTuiExtensionsList([
        entry({ id: "example.context" }),
    ]), { name: "space", sequence: " " });
    expect(toggle.mutate).toEqual({
        operation: "disable",
        entry: expect.objectContaining({ id: "example.context" }),
    });

    expect(handleTuiExtensionsListKey(
        openTuiExtensionsList([entry({ id: "example.context" })]),
        { name: "escape" },
    )).toEqual({ handled: true });
});

test("disabled managed rows offer enable, and Remove uses a second screen", () => {
    let state = openTuiExtensionsList([
        entry({ id: "example.context", enabled: false }),
    ]);
    expect(renderTuiExtensionsList(state)).toContain("Space enable");
    expect(
        handleTuiExtensionsListKey(state, { name: "space", sequence: " " }).mutate?.operation,
    ).toBe("enable");

    state = key(state, "enter");
    state = key(state, "down");
    expect(renderTuiExtensionsList(state)).toContain("› Remove");
    state = key(state, "enter");
    expect(renderTuiExtensionsList(state)).toBe([
        "Remove example.context?",
        "",
        "This deletes the managed copy. The source is untouched.",
        "",
        "⏎ remove · esc back",
    ].join("\n"));
    const remove = handleTuiExtensionsListKey(state, { name: "enter" });
    expect(remove.mutate).toEqual({
        operation: "remove",
        entry: expect.objectContaining({ id: "example.context" }),
    });
    state = key(state, "escape");
    expect(state.screen).toBe("detail");
});

test("a load error is its own screen and Escape closes it", () => {
    const state = openTuiExtensionsListError("permission denied");
    expect(renderTuiExtensionsList(state)).toBe([
        "Extensions",
        "",
        "permission denied",
        "",
        "esc close",
    ].join("\n"));
    expect(handleTuiExtensionsListKey(state, { name: "escape" })).toEqual({
        handled: true,
    });
});

test("sync keeps the selected id after a reload and drops a removed copy", () => {
    const original = openTuiExtensionsList([
        entry({ id: "example.context" }),
        entry({ id: "vera.btw", version: "1.2.0" }),
    ]);
    const moved = key(original, "down");
    const synced = syncTuiExtensionsList(moved, [
        entry({ id: "example.context", enabled: false }),
        entry({ id: "vera.btw", version: "1.2.0" }),
    ], new Set(["vera.btw"]));
    expect(synced.rows[synced.selectedIndex]?.id).toBe("vera.btw");
    expect(synced.rows[synced.selectedIndex]?.loaded).toBe(true);
    expect(synced.rows[0]?.status).toBe("disabled");

    const afterRemove = syncTuiExtensionsList(
        { ...moved, screen: "detail" },
        [entry({ id: "example.context" })],
    );
    expect(afterRemove.screen).toBe("list");
    expect(afterRemove.rows).toHaveLength(1);
});

test("the OpenTUI card paints the selected row", async () => {
    const harness = await createTestRenderer({ width: 80, height: 24 });
    try {
        const view = createTuiExtensionsListView(harness.renderer);
        view.update(openTuiExtensionsList([
            entry({ id: "example.context" }),
            entry({ id: "vera.btw", version: "1.2.0" }),
        ]));
        expect(view.box.visible).toBe(false);
        view.box.visible = true;
        harness.renderer.root.add(view.box);
        await harness.flush();
        const frame = harness.captureCharFrame();
        expect(frame).toContain("Extensions");
        expect(frame).toContain("example.context");
        expect(frame).toContain("enabled");
        expect(frame).toContain("commands");
    } finally {
        harness.renderer.destroy();
    }
});
