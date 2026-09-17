import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { TUI_ACCENT, TUI_MUTED, TUI_PANEL, TUI_SELECTION_TEXT } from "../../clients/tui/state.ts";

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

test("left and right are consumed on the list and the detail screen", () => {
    let state = openTuiExtensionsList([
        entry({ id: "example.context" }),
        entry({ id: "example.tools" }),
    ]);
    state = key(state, "down");
    expect(key(key(state, "left"), "right")).toEqual(state);

    const detail = key(state, "enter");
    expect(detail.screen).toBe("detail");
    expect(key(key(detail, "left"), "right")).toEqual(detail);
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
        expect(frame).toContain("› example.context");
        expect(frame).toContain("enabled");
        expect(frame).toContain("commands");
    } finally {
        harness.renderer.destroy();
    }
});

test("bundled extension details expose their settings command without install mutations", () => {
    const opened = openTuiExtensionsList([entry({ id: "vera.web-search", managed: false, bundled: true })], new Set(["vera.web-search"]));
    const state: TuiExtensionsListState = { ...opened, screen: "detail", rows: opened.rows.map((row) => ({ ...row,
        settingsCommands: [{ name: "search-providers", label: "Search providers" }],
    })) };
    expect(renderTuiExtensionsList(state)).toContain("Search providers");
    expect(renderTuiExtensionsList(state)).toContain("enabled");
    expect(renderTuiExtensionsList(state)).not.toContain("Remove");
    expect(handleTuiExtensionsListKey(state, { name: "return" })).toMatchObject({ command: "search-providers", handled: true });
    expect(handleTuiExtensionsListKey(state, { name: "escape" }).state?.screen).toBe("list");
});

test("the rendered bundled settings action uses its command label", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiExtensionsListView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    const opened = openTuiExtensionsList([entry({ id: "vera.web-search", bundled: true, managed: false })]);
    const state: TuiExtensionsListState = { ...opened, screen: "detail", rows: opened.rows.map((row) => ({ ...row,
        settingsCommands: [{ name: "search-providers", label: "Search providers" }],
    })) };
    try {
        view.update(state);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Search providers");
        expect(setup.captureCharFrame()).not.toContain("Disable");
        expect(setup.captureCharFrame()).toContain("› Search providers");
    } finally { setup.renderer.destroy(); }
});

for (const [width, height] of [[120, 36], [80, 24], [60, 20]] as const) {
    test(`extension rows preserve columns, spacing, and footer at ${width}x${height}`, async () => {
        const setup = await createTestRenderer({ width, height });
        try {
            const view = createTuiExtensionsListView(setup.renderer);
            setup.renderer.root.add(view.box);
            view.box.visible = true;
            const entries = Array.from({ length: 14 }, (_, index) => entry({
                id: `extension.${String(index).padStart(2, "0")}`,
                version: index % 2 === 0 ? "0.1.0" : "12.34.56",
                scope: index < 2 ? "project" : "profile",
                capabilities: ["client.commands.register", "client.context.read", "client.sessions.read"],
            }));
            const initial = openTuiExtensionsList(entries);
            for (const selectedIndex of [0, 6, 13]) {
                view.update({ ...initial, selectedIndex });
                await setup.flush();
                const lines = setup.captureCharFrame().split("\n");
                const rows = lines.map((text, y) => ({ text, y })).filter((row) => row.text.includes("extension."));
                expect(rows.some((row) => row.text.includes(`› extension.${String(selectedIndex).padStart(2, "0")}`))).toBe(true);
                expect(new Set(rows.map((row) => row.text.indexOf("enabled"))).size).toBe(1);
                expect(new Set(rows.map((row) => row.text.indexOf("v"))).size).toBe(1);
                const footerY = lines.findIndex((line) => line.includes("⏎ details"));
                expect(footerY).toBeGreaterThan(rows.at(-1)!.y + 2);
                expect(lines[footerY]).not.toContain("commands");
                expect(lines[footerY]).toContain("esc");
                expect(lines[footerY]).toContain("Space disable");
                const active = rows.find((row) => row.text.includes("›"))!;
                const caretX = active.text.indexOf("›");
                const cells = (y: number) => setup.captureSpans().lines[y]!.spans.flatMap((span) =>
                    Array.from({ length: span.width }, () => ({ fg: span.fg.toInts(), bg: span.bg.toInts() })));
                const selected = cells(active.y);
                const statusEnd = active.text.indexOf("enabled") + "enabled".length;
                expect(selected.slice(caretX, statusEnd).every((cell) =>
                    cell.bg.every((value, index) => value === RGBA.fromHex(TUI_ACCENT).toInts()[index]))).toBe(true);
                expect(selected[caretX]!.fg).toEqual(RGBA.fromHex(TUI_SELECTION_TEXT).toInts());
                expect(cells(active.y + 1)[caretX + 2]!.fg).toEqual(RGBA.fromHex(TUI_MUTED).toInts());
                expect(cells(active.y + 1)[caretX + 2]!.bg).toEqual(RGBA.fromHex(TUI_PANEL).toInts());
                for (const row of rows) {
                    expect(lines[row.y + 1]!.indexOf("commands")).toBe(row.text.indexOf("extension."));
                    expect(lines[row.y + 2]!.trim()).toBe("");
                }
                expect(view.box.height).toBeLessThanOrEqual(height - view.box.screenY - 2);
            }
        } finally {
            setup.renderer.destroy();
        }
    });
}

test("narrow extension rows clip long names and contributions while keeping status", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
        const view = createTuiExtensionsListView(setup.renderer);
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        const state = openTuiExtensionsList([entry({
            id: "example.extension-with-a-long-name",
            enabled: false,
            capabilities: ["client.commands.register", "client.context.read", "client.sessions.read", "client.experimental_tui", "client.picker", "client.agents"],
        })]);
        view.update(state);
        await setup.flush();
        const rows = setup.captureCharFrame().split("\n");
        const name = rows.find((line) => line.includes("›"))!;
        expect(name).toContain("…");
        expect(name).toContain("v0.1.0  disabled");
        expect(rows.find((line) => line.includes("commands"))).toContain("…");
        expect(key(state, "return").screen).toBe("detail");
        expect(renderTuiExtensionsList(key(state, "return"))).toContain("example.extension-with-a-long-name");
    } finally { setup.renderer.destroy(); }
});
