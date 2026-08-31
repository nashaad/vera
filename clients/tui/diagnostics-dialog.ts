import {
    bg,
    BoxRenderable,
    bold,
    fg,
    MarkdownRenderable,
    ScrollBoxRenderable,
    StyledText,
    SyntaxStyle,
    TextRenderable,
    type RenderContext,
    type TextChunk,
} from "@opentui/core";

import {
    DIALOG_CARD_Z_INDEX,
    dialogHeaderNode,
} from "./dialog-chrome.ts";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SELECTION_TEXT,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";
import type { TuiDiagnosticsScope } from "./diagnostics.ts";
import { tuiBindingId } from "./keymap.ts";

export const INSPECT_COPY_HINT = "drag a section · enter copies all";

/** Cap so the report is a column, not a full-bleed pane. */
export const INSPECT_DIALOG_MAX_WIDTH = 72;
const INSPECT_DIALOG_GUTTER = 2;

/**
 * Where the inspect card sits. Wide terminals keep a 72-column column;
 * a skinny terminal keeps a two-column gutter and uses the rest.
 */
export function inspectDialogFrame(terminalWidth: number): {
    readonly left: number;
    readonly width: number;
} {
    const width = Math.max(
        24,
        Math.min(
            INSPECT_DIALOG_MAX_WIDTH,
            terminalWidth - INSPECT_DIALOG_GUTTER * 2,
        ),
    );
    const left = Math.max(
        0,
        Math.floor((Math.max(terminalWidth, width) - width) / 2),
    );
    return { left, width };
}

export interface TuiDiagnosticsDialogState {
    readonly text: string;
    readonly title?: string;
    readonly footerText?: string;
    readonly scope?: TuiDiagnosticsScope;
    readonly copyReady?: boolean;
    readonly copyStatus?: "copied" | "failed";
}

export type TuiDiagnosticsDialogAction =
    | "copy"
    | "dismiss"
    | "switch_scope";

export interface TuiDiagnosticsDialogKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface TuiDiagnosticsDialogView {
    readonly box: BoxRenderable;
    focus(): void;
    contentWidth(): number;
    update(state: TuiDiagnosticsDialogState): void;
    repaint(): void;
}

export interface TuiDiagnosticsDialogOptions {
    readonly id?: string;
    readonly title?: string;
    readonly footerText?: string;
    readonly pendingText?: string;
    readonly skipFirstLine?: boolean;
    readonly showScopeTabs?: boolean;
    /** Doctor reports paint Result / stray / role labels; copy stays plain. */
    readonly emphasis?: "doctor";
}

export function handleTuiDiagnosticsDialogKey(
    key: TuiDiagnosticsDialogKey,
    canSwitchScope = false,
): TuiDiagnosticsDialogAction | undefined {
    if (key.ctrl || key.meta) {
        return undefined;
    }
    if (
        canSwitchScope
        && tuiBindingId("diagnostics", key) === "switch_diagnostics_scope"
    ) {
        return "switch_scope";
    }
    if (key.shift) return undefined;
    if (key.name === "escape") {
        return "dismiss";
    }
    if (
        key.name === "return"
        || key.name === "enter"
        || key.name === "kpenter"
    ) {
        return "copy";
    }
    return undefined;
}

export function createTuiDiagnosticsDialogView(
    renderer: RenderContext,
    options: TuiDiagnosticsDialogOptions = {},
): TuiDiagnosticsDialogView {
    const id = options.id ?? "diagnostics-dialog";
    const defaultTitle = options.title ?? "Diagnostics";
    const frame = inspectDialogFrame(renderer.width);
    const box = new BoxRenderable(renderer, {
        id,
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: "6%",
        left: frame.left,
        width: frame.width,
        // Stop above the composer rather than at a fraction of the screen. The
        // composer's own rows say what the session is answering as, and an
        // overlay drawn across them reads as two surfaces fighting.
        bottom: 8,
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
        visible: false,
    });
    const header = dialogHeaderNode(renderer, defaultTitle);
    const headerTitle = header.getChildren()[0] as TextRenderable | undefined;
    const scopeTabs = options.showScopeTabs === true
        ? new TextRenderable(renderer, {
            id: `${id}-scope-tabs`,
            content: diagnosticsScopeTabs("session"),
            width: "100%",
            height: 1,
            marginTop: 1,
        })
        : undefined;
    let markdownStyle = inspectMarkdownStyle();
    let occupancyBlock = 0;
    const bodyMarkdown = new MarkdownRenderable(renderer, {
        id: `${id}-markdown`,
        content: "",
        syntaxStyle: markdownStyle,
        fg: TUI_TEXT,
        width: "100%",
        conceal: true,
        internalBlockMode: "top-level",
        tableOptions: {
            style: "columns",
            columnFitter: "balanced",
            wrapMode: "word",
            selectable: true,
        },
        renderNode(token) {
            if (!/[█░▒]/u.test(token.raw)) return undefined;
            occupancyBlock += 1;
            return new TextRenderable(renderer, {
                id: `${id}-occupancy-${occupancyBlock}`,
                content: styledInspectOccupancy(token.raw.trimEnd()),
                width: "100%",
                wrapMode: "char",
                selectable: true,
            });
        },
    });
    const body = new ScrollBoxRenderable(renderer, {
        id: `${id}-body`,
        width: "100%",
        flexGrow: 1,
        minHeight: 1,
        marginTop: 1,
        scrollY: true,
        // A horizontal scroll viewport measures its child without a width
        // constraint, which prevents Markdown's word/character fallback from
        // wrapping long paths. Inspect reports scroll vertically only.
        scrollX: false,
        focusable: true,
        viewportCulling: true,
        contentOptions: { flexDirection: "column" },
    });
    body.add(bodyMarkdown);
    const footer = new BoxRenderable(renderer, {
        id: `${id}-footer`,
        width: "100%",
        height: 2,
        marginTop: 1,
        flexDirection: "column",
    });
    const shareHint = new TextRenderable(renderer, {
        content: options.footerText ?? "Share this when reporting an issue.",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        wrapMode: "none",
    });
    const copyHint = new TextRenderable(renderer, {
        content: INSPECT_COPY_HINT,
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        wrapMode: "none",
    });
    footer.add(shareHint);
    footer.add(copyHint);
    box.add(header);
    if (scopeTabs !== undefined) box.add(scopeTabs);
    box.add(body);
    box.add(footer);
    box.once("destroyed", () => markdownStyle.destroy());
    let activeScope: TuiDiagnosticsScope = "session";

    const refreshFrame = (): void => {
        const next = inspectDialogFrame(renderer.width);
        box.left = next.left;
        box.width = next.width;
    };

    const documentWidth = (): number => {
        const frame = inspectDialogFrame(renderer.width);
        const laidOut = typeof body.width === "number" && body.width > 1
            ? body.width
            : frame.width - 4;
        // Leave the vertical scrollbar column out of the document width so a
        // full-width occupancy bar does not force horizontal scroll.
        return Math.max(20, laidOut - 1);
    };

    return {
        box,
        focus(): void {
            body.focus();
        },
        contentWidth(): number {
            refreshFrame();
            return documentWidth();
        },
        update(state): void {
            // Absolute coordinates do not follow a terminal resize. Re-read
            // the viewport whenever the open dialog paints so the capped card
            // remains centered instead of drifting against the right edge.
            refreshFrame();
            if (headerTitle !== undefined && state.title !== undefined) {
                headerTitle.content = state.title;
            }
            if (state.footerText !== undefined) {
                shareHint.content = state.footerText;
            }
            if (scopeTabs !== undefined) {
                activeScope = state.scope ?? "session";
                scopeTabs.content = diagnosticsScopeTabs(activeScope);
            }
            bodyMarkdown.content = inspectDocumentMarkdown(
                state.text,
                options.skipFirstLine,
            );
            copyHint.content = state.copyStatus === "copied"
                ? "✓ copied"
                : state.copyStatus === "failed"
                ? "copy failed · enter retry"
                : state.copyReady === false
                ? options.pendingText ?? "finding session path…"
                : INSPECT_COPY_HINT;
            copyHint.fg = state.copyStatus === "copied"
                ? TUI_SUCCESS
                : TUI_MUTED;
        },
        repaint(): void {
            box.backgroundColor = TUI_PANEL;
            const retiredStyle = markdownStyle;
            markdownStyle = inspectMarkdownStyle();
            bodyMarkdown.syntaxStyle = markdownStyle;
            bodyMarkdown.fg = TUI_TEXT;
            bodyMarkdown.refreshStyles();
            retiredStyle.destroy();
            if (scopeTabs !== undefined) {
                scopeTabs.content = diagnosticsScopeTabs(activeScope);
            }
            shareHint.fg = TUI_MUTED;
            copyHint.fg = TUI_MUTED;
        },
    };
}

function inspectMarkdownStyle(): SyntaxStyle {
    return SyntaxStyle.fromStyles({
        default: { fg: TUI_TEXT },
        "markup.heading": { fg: TUI_TEXT, bold: true },
        "markup.strong": { fg: TUI_TEXT, bold: true },
        "markup.italic": { fg: TUI_TEXT, italic: true },
        "markup.raw": { fg: TUI_NOTICE },
        "markup.raw.block": { fg: TUI_NOTICE },
        "markup.list": { fg: TUI_ACCENT },
        "markup.quote": { fg: TUI_MUTED, italic: true },
        conceal: { fg: TUI_ELEMENT },
    });
}

function diagnosticsScopeTabs(scope: TuiDiagnosticsScope): StyledText {
    const tab = (label: string, active: boolean) =>
        active
            ? [bold(fg(TUI_SELECTION_TEXT)(bg(TUI_ACCENT)(` ${label} `)))]
            : [fg(TUI_MUTED)(` ${label} `)];
    return new StyledText([
        ...tab("Session", scope === "session"),
        fg(TUI_MUTED)("  "),
        ...tab("Vera", scope === "vera"),
        fg(TUI_MUTED)("    tab switch"),
    ]);
}

/** Context occupancy remains legible as used, free, and reserved capacity. */
export function styledInspectOccupancy(text: string): StyledText {
    const chunks: TextChunk[] = [];
    let buffer = "";
    let tone: "used" | "free" | "reserve" | "text" | undefined;
    const flush = (): void => {
        if (buffer.length === 0 || tone === undefined) return;
        const color = tone === "used"
            ? TUI_ACCENT
            : tone === "free"
                ? TUI_ELEMENT
                : tone === "reserve"
                    ? TUI_NOTICE
                    : TUI_TEXT;
        chunks.push(fg(color)(buffer));
        buffer = "";
    };
    for (const character of Array.from(text)) {
        const next = character === "█"
            ? "used"
            : character === "░"
                ? "free"
                : character === "▒"
                    ? "reserve"
                    : "text";
        if (next !== tone) {
            flush();
            tone = next;
        }
        buffer += character;
    }
    flush();
    return new StyledText(chunks);
}

/** Visible inspect-dialog body: the markdown, optionally without the H1 title. */
export function inspectDocumentLines(
    text: string,
    skipFirstLine?: boolean,
): string[] {
    return text.split("\n").slice(skipFirstLine === false ? 0 : 1);
}

export function inspectDocumentMarkdown(
    text: string,
    skipFirstLine?: boolean,
): string {
    return inspectDocumentLines(text, skipFirstLine).join("\n");
}
