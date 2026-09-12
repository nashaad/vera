import { expect, test } from "bun:test";

import {
    DEFAULT_TUI_APPEARANCE,
    fitTuiAppearance,
    resolveTuiAppearance,
    tuiComposerContentIndent,
    tuiComposerOverlayInset,
} from "../../clients/tui/appearance.ts";

test("TUI appearance defaults preserve the current client layout", () => {
    expect(resolveTuiAppearance()).toEqual(DEFAULT_TUI_APPEARANCE);
    expect(tuiComposerContentIndent(DEFAULT_TUI_APPEARANCE)).toBe(4);
    expect(tuiComposerOverlayInset(DEFAULT_TUI_APPEARANCE)).toEqual({
        left: 0,
        right: 0,
        paddingLeft: 4,
        paddingRight: 4,
    });
});

test("TUI appearance resolves JSON overrides and derives tip alignment", () => {
    const appearance = resolveTuiAppearance({
        transcript: {
            padding_left: 2,
            padding_right: 4,
            activity_indent: 3,
            message_spacing: 2,
            tool_group_spacing: 1,
            separator_visible: false,
            separator_spacing_before: 1,
            separator_spacing_after: 2,
            separator_color: "#181818",
        },
        composer: {
            margin_horizontal: 4,
            padding_horizontal: 2,
            boundary_color: "#303030",
        },
    });

    expect(appearance).toEqual({
        dialogHeaderStyle: "underline",
        dialogSearchStyle: "fill",
        transcriptPaddingLeft: 2,
        transcriptPaddingRight: 4,
        activityIndent: 3,
        messageSpacing: 2,
        toolGroupSpacing: 1,
        separatorVisible: false,
        separatorSpacingBefore: 1,
        separatorSpacingAfter: 2,
        transcriptSeparatorColor: "#181818",
        composerMarginHorizontal: 4,
        composerPaddingHorizontal: 2,
        composerTipIndent: 5,
        composerBoundaryColor: "#303030",
    });
    expect(tuiComposerContentIndent(appearance)).toBe(7);
});

test("an explicit composer tip indent wins over derived alignment", () => {
    expect(resolveTuiAppearance({
        composer: { margin_horizontal: 4, tip_indent: 2 },
    }).composerTipIndent).toBe(2);
});

test("dialog header style defaults to underline and resolves the box override", () => {
    expect(resolveTuiAppearance().dialogHeaderStyle).toBe("underline");
    expect(resolveTuiAppearance({ dialogs: { header_style: "box" } }).dialogHeaderStyle).toBe("box");
});

test("dialog search defaults to fill and resolves a border independently of its title", () => {
    expect(resolveTuiAppearance().dialogSearchStyle).toBe("fill");
    expect(resolveTuiAppearance({ dialogs: { search_style: "plain" } }).dialogSearchStyle).toBe("plain");
    expect(resolveTuiAppearance({ dialogs: { search_style: "border" } })).toMatchObject({
        dialogHeaderStyle: "underline", dialogSearchStyle: "border",
    });
});

test("composer geometry fits narrow terminals without changing configured intent", () => {
    const appearance = resolveTuiAppearance({
        composer: { margin_horizontal: 20, padding_horizontal: 12 },
    });

    expect(fitTuiAppearance(appearance, 100)).toEqual(appearance);
    expect(fitTuiAppearance(appearance, 30)).toMatchObject({
        transcriptPaddingLeft: 0,
        transcriptPaddingRight: 1,
        composerMarginHorizontal: 8,
        composerPaddingHorizontal: 0,
        composerTipIndent: 9,
    });
    expect(tuiComposerContentIndent(fitTuiAppearance(appearance, 30)))
        .toBe(9);
});

test("transcript padding fits narrow terminals proportionally", () => {
    const appearance = resolveTuiAppearance({
        transcript: { padding_left: 20, padding_right: 20 },
    });

    expect(fitTuiAppearance(appearance, 40)).toMatchObject({
        transcriptPaddingLeft: 14,
        transcriptPaddingRight: 14,
    });
    expect(fitTuiAppearance(appearance, 20)).toMatchObject({
        transcriptPaddingLeft: 4,
        transcriptPaddingRight: 4,
    });
});
