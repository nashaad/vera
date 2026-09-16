import { expect, test } from "bun:test";

import {
    clippedToWidth,
    pickerFooter,
    type TuiModelPickerTab,
    type TuiSettingsPickerKind,
    type TuiSettingsPickerOption,
} from "../../clients/tui/settings-picker.ts";

const KINDS: readonly TuiSettingsPickerKind[] = [
    "model",
    "provider",
    "reasoning",
    "permissions",
    "theme",
    "session",
    "configure",
    "settings",
    "permission_settings",
    "reviewer_settings",
    "reviewer",
    "model_assignment",
];

const TABS: readonly TuiModelPickerTab[] = ["pool", "all", "defaults", "help"];

test("provider footer drops whole optional hints and preserves Escape", () => {
    const option = { value: "provider", label: "Provider", description: "", hasCredential: true, endpointEditable: true, refreshable: true };
    for (const width of [40, 60, 80, 100]) {
        const footer = pickerFooter({ kind: "provider", options: [option], allOptions: [option], query: "", selectedIndex: 0 }, width);
        expect(footer).toContain("⏎ actions");
        expect(footer).toContain("esc close");
        expect(footer).not.toContain("…");
        expect(Bun.stringWidth(footer)).toBeLessThanOrEqual(width);
    }
});

const OPTION: TuiSettingsPickerOption = {
    value: "openrouter/big-1",
    label: "a model with a long enough name to crowd a narrow card",
    description: "openrouter",
    provider: "openrouter",
    model: "big-1",
    note:
        "a sentence long enough that a footer carrying it would run past the "
        + "edge of the card and take the blank line under it as well",
};

function pane(kind: TuiSettingsPickerKind, tab?: TuiModelPickerTab) {
    return {
        kind,
        allOptions: [OPTION],
        options: [OPTION],
        selectedIndex: 0,
        query: "",
        ...(tab === undefined ? {} : { tab }),
    };
}

// The card draws the footer on one line and keeps a blank line under it. A
// footer wider than the card wraps into that line, so the pane loses the
// padding at its bottom edge.
test("no picker's footer outgrows the card it is drawn in", () => {
    for (const width of [24, 40, 60, 80, 120, 200]) {
        for (const kind of KINDS) {
            const tabs = kind === "model" ? TABS : [undefined];
            for (const tab of tabs) {
                const footer = pickerFooter(pane(kind, tab), width);
                expect([kind, tab, Bun.stringWidth(footer) <= width])
                    .toEqual([kind, tab, true]);
            }
        }
    }
});

test("a clipped line ends in an ellipsis and still fits", () => {
    expect(clippedToWidth("abcdef", 4)).toBe("abc…");
    expect(clippedToWidth("abc", 4)).toBe("abc");
    expect(clippedToWidth("abcdef", 0)).toBe("abcdef");
});

// The card sizes itself from a line count, and its background is drawn to that
// height. A line the count does not know about pushes the footer onto the
// bottom edge, so the card loses the blank line under its hints.
test("a subtitle does not cost the card its bottom padding", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { createTuiSettingsPickerView, startTuiModelAssignmentPicker } =
        await import("../../clients/tui/settings-picker.ts");
    const pooled = [{
        provider: "openrouter",
        model: "big-1",
        label: "big",
        available: true,
        verified: true,
        levels: [],
    }] as const;
    async function cardHeight(subtitled: boolean): Promise<number> {
        const state = startTuiModelAssignmentPicker(
            "eco",
            "eco",
            "for work a turn waits on",
            pooled as never,
        );
        const setup = await createTestRenderer({ width: 100, height: 30 });
        const view = createTuiSettingsPickerView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        view.update(
            subtitled ? state : { ...state, subtitle: undefined },
        );
        await setup.flush();
        const height = view.box.height;
        setup.renderer.destroy();
        return height;
    }
    // The subtitle block is its own margin, two wrapped lines, and the blank
    // under it, so the card grows by four.
    expect(await cardHeight(true)).toBe(await cardHeight(false) + 4);
});

/** The rows the card drew, measured from its own top edge. */
function contentBottom(box: {
    y: number;
    height: number;
    getChildren(): readonly { y: number; height: number }[];
}): number {
    return Math.max(
        ...box.getChildren().map((child) => child.y - box.y + child.height),
    );
}

// The card sizes itself from its content, so nothing it draws can push the
// footer onto the bottom edge. This is the check that keeps it that way: the
// last row of any pane, at any width, is the blank one under the hints.
test("every pane keeps a blank row under whatever it draws", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { createTuiSettingsPickerView } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    for (const width of [40, 80, 140]) {
        for (const kind of KINDS) {
            const tabs = kind === "model" ? TABS : [undefined];
            for (const tab of tabs) {
                const setup = await createTestRenderer({ width, height: 40 });
                const view = createTuiSettingsPickerView(setup.renderer);
                setup.renderer.root.add(view.surface);
                view.surface.visible = true;
                // The theme rows draw a swatch, so that pane needs a name
                // the catalog knows rather than the shared model fixture.
                const state = kind === "theme"
                    ? { ...pane(kind, tab), options: [{ value: "default", label: "default" }], allOptions: [{ value: "default", label: "default" }] }
                    : pane(kind, tab);
                view.update(state as never);
                await setup.flush();
                const slack = view.box.height - contentBottom(view.box as never);
                setup.renderer.destroy();
                expect([kind, tab, width, slack >= 1]).toEqual([
                    kind,
                    tab,
                    width,
                    true,
                ]);
            }
        }
    }
});

test("the command palette keeps a blank row under its hints", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { createTuiCommandPaletteView } = await import(
        "../../clients/tui/command-palette.ts"
    );
    const setup = await createTestRenderer({ width: 80, height: 40 });
    const view = createTuiCommandPaletteView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    view.update({
        commands: [{
            name: "help",
            label: "/help",
            description: "what this does",
            usage: "/help",
        }],
        selectedIndex: 0,
        query: "",
    } as never);
    await setup.flush();
    expect(view.box.height - contentBottom(view.box as never))
        .toBeGreaterThanOrEqual(1);
    setup.renderer.destroy();
});
