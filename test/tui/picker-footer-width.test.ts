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
    "settings",
    "permission_settings",
    "reviewer_settings",
    "reviewer",
    "model_assignment",
];

const TABS: readonly TuiModelPickerTab[] = ["pool", "all", "assigned", "help"];

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
