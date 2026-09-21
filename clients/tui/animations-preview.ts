import {
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
    type RenderContext,
    type TextChunk,
} from "@opentui/core";

import {
    renderTuiActivityBar,
    type TuiActivityKind,
    type TuiAnimationLevel,
} from "./activity-bar.ts";
import { centeredDialogSurface, dialogHeaderNode } from "./dialog-chrome.ts";
import { TUI_ACCENT, TUI_ELEMENT, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";
import { tuiThemeProperties, type TuiThemeBinding } from "./theme-bindings.ts";

interface TuiAnimationsPreviewRow {
    readonly kind: TuiActivityKind;
    readonly label: string;
}

export const ANIMATIONS_PREVIEW_ROWS: readonly TuiAnimationsPreviewRow[] = [
    { kind: "waiting", label: "request sent, nothing back yet" },
    { kind: "thinking", label: "reasoning, or quiet for over 2 s" },
    { kind: "reading", label: "reading, searching, or fetching" },
    { kind: "running", label: "running any other tool" },
    { kind: "writing", label: "writing the reply, or editing files" },
];

const KIND_COLUMNS = Math.max(...ANIMATIONS_PREVIEW_ROWS.map((row) => row.kind.length));

export type TuiAnimationsPreviewKeyResult = "dismiss" | undefined;

export interface TuiAnimationsPreviewView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    update(level: TuiAnimationLevel, nowMs: number): void;
}

export function handleTuiAnimationsPreviewKey(
    key: { readonly name: string; readonly ctrl?: boolean; readonly meta?: boolean },
): TuiAnimationsPreviewKeyResult {
    if (key.ctrl || key.meta) return undefined;
    return key.name === "escape" ? "dismiss" : undefined;
}

// Colours are read per call so a theme change shows on the next frame.
export function tuiAnimationsPreviewChunks(level: TuiAnimationLevel, nowMs: number): TextChunk[] {
    const chunks: TextChunk[] = [];
    ANIMATIONS_PREVIEW_ROWS.forEach((row, index) => {
        if (index > 0) chunks.push(fg(TUI_TEXT)("\n"));
        chunks.push(fg(TUI_MUTED)(`${index + 1}  `));
        chunks.push(fg(TUI_TEXT)(`${row.kind.padEnd(KIND_COLUMNS)}  `));
        const cells = renderTuiActivityBar(row.kind, level, nowMs, { active: TUI_ACCENT, dim: TUI_ELEMENT });
        for (const cell of cells) chunks.push(fg(cell.color)(cell.glyph));
        chunks.push(fg(TUI_MUTED)(`  ${row.label}`));
    });
    return chunks;
}

// Two short lines so the card never truncates them on a narrow terminal.
export function tuiAnimationsPreviewFooter(level: TuiAnimationLevel): string {
    return `Playing at Animation level ${level} of 3 (0 is still).\nChange it in /settings, Animation.`;
}

export function createTuiAnimationsPreviewView(renderer: RenderContext): TuiAnimationsPreviewView {
    const rows = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: ANIMATIONS_PREVIEW_ROWS.length,
        wrapMode: "none",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 2,
        wrapMode: "none",
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "animations-preview",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "70%",
        height: "auto",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
    });
    box.add(dialogHeaderNode(renderer, "Animations"));
    box.add(rows);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "animations-preview-surface", box);
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        update(level, nowMs): void {
            rows.content = new StyledText(tuiAnimationsPreviewChunks(level, nowMs));
            footer.content = tuiAnimationsPreviewFooter(level);
        },
    };
}
