import {
    BoxRenderable,
    fg,
    StyledText,
    type TextChunk,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";

// Shared building blocks for Vera's overlay dialogs. Every picker/dialog is an
// unbordered card: a bold title with an "esc" affordance, an optional search
// line, highlight-bar rows, and a muted footer of key hints. Keeping these in
// one place means the model picker, theme picker, question, approval, and
// rewind dialogs stay visually identical instead of drifting apart.

// Each row reserves leading columns so a current-choice marker and the row
// label line up on the same column whether or not the marker is present.
export const DIALOG_GUTTER_WIDTH = 3;

// The card chrome that surrounds a variable-height row list: the header line,
// the three-line search block, the footer, and the card's own top padding.
export const DIALOG_CHROME_HEIGHT = 8;

export function dialogHeaderNode(
    renderer: RenderContext,
    title: string,
    hint = "esc",
): BoxRenderable {
    const header = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
    });
    header.add(new TextRenderable(renderer, {
        content: title,
        fg: TUI_TEXT,
        attributes: 1,
    }));
    header.add(new TextRenderable(renderer, {
        content: hint,
        fg: TUI_MUTED,
    }));
    return header;
}

export function dialogSearchNode(
    renderer: RenderContext,
    query: string,
    placeholder = "Search",
): TextRenderable {
    const typed = query.length > 0;
    return new TextRenderable(renderer, {
        content: new StyledText([
            fg(TUI_MUTED)("⌕  "),
            fg(typed ? TUI_TEXT : TUI_MUTED)(typed ? query : placeholder),
            // A block caret keeps the line reading as a live input rather than
            // a static label once the query empties out again.
            fg(TUI_ACCENT)("▏"),
        ]),
        width: "100%",
        height: 3,
        paddingLeft: 1,
        paddingTop: 1,
    });
}

export function dialogFooterNode(
    renderer: RenderContext,
    hint: string,
): TextRenderable {
    return new TextRenderable(renderer, {
        content: hint,
        fg: TUI_MUTED,
        width: "100%",
        height: 2,
        paddingLeft: 1,
        paddingTop: 1,
    });
}

export function dialogGroupHeaderNode(
    renderer: RenderContext,
    label: string,
    spaced: boolean,
): TextRenderable {
    return new TextRenderable(renderer, {
        content: label,
        fg: TUI_ACCENT,
        attributes: 1,
        width: "100%",
        height: 1,
        paddingLeft: DIALOG_GUTTER_WIDTH,
        ...(spaced ? { marginTop: 1 } : {}),
    });
}

export interface DialogRowContent {
    readonly label: string;
    // Fixed gutter text before the label (a current-choice dot, a choice
    // number). Accent-toned unless the row is active.
    readonly leading?: string;
    // Follows the label inline in the muted tone.
    readonly description?: string;
    // Right-aligned trailing column in the muted tone (e.g. a provider name).
    readonly meta?: string;
    readonly active: boolean;
    readonly current?: boolean;
    // Wrapping rows grow to fit their label; the highlight bar covers every
    // wrapped line. Non-wrapping rows stay one line and clip.
    readonly wrap?: boolean;
}

export function dialogOptionRow(
    renderer: RenderContext,
    content: DialogRowContent,
): BoxRenderable {
    const background = content.active ? TUI_ACCENT : TUI_PANEL;
    const label = content.active
        ? TUI_BACKGROUND
        : content.current
            ? TUI_ACCENT
            : TUI_TEXT;
    const accent = content.active ? TUI_BACKGROUND : TUI_ACCENT;
    const detail = content.active ? TUI_BACKGROUND : TUI_MUTED;
    const row = new BoxRenderable(renderer, {
        width: "100%",
        height: content.wrap ? "auto" : 1,
        flexDirection: "row",
        backgroundColor: background,
        paddingLeft: 1,
        paddingRight: 1,
    });
    if (content.leading !== undefined) {
        row.add(new TextRenderable(renderer, {
            content: new StyledText([fg(accent)(content.leading)]),
            bg: background,
            flexShrink: 0,
        }));
    }
    const labelChunks: TextChunk[] = [fg(label)(content.label)];
    if (content.description !== undefined) {
        labelChunks.push(fg(detail)(`  ${content.description}`));
    }
    row.add(new TextRenderable(renderer, {
        content: new StyledText(labelChunks),
        bg: background,
        attributes: content.active ? 1 : 0,
        flexGrow: 1,
        flexShrink: 1,
        ...(content.wrap
            ? { wrapMode: "word" as const }
            : { wrapMode: "none" as const, overflow: "hidden" as const }),
    }));
    if (content.meta !== undefined) {
        row.add(new TextRenderable(renderer, {
            content: new StyledText([fg(detail)(content.meta)]),
            bg: background,
            flexShrink: 0,
        }));
    }
    return row;
}
