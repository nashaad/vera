import {
    BoxRenderable,
    fg,
    MarkdownRenderable,
    ScrollBoxRenderable,
    StyledText,
    SyntaxStyle,
    TextTableRenderable,
    TextRenderable,
    type RenderContext,
    type TextChunk,
} from "@opentui/core";

import {
    DIALOG_CARD_Z_INDEX,
    dialogHeaderNode,
    dialogOptionRows,
    dialogRowPointer,
    type DialogRowPointer,
    updateDialogHeaderTitle,
} from "./dialog-chrome.ts";
import {
    TUI_ACCENT,
    TUI_DANGER,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";
import type { TuiDiagnosticsScope } from "./diagnostics.ts";
import { isTuiDialTabKey, tuiBindingId } from "./keymap.ts";

export const INSPECT_COPY_HINT = "drag a section · enter copies all";

export const INSPECT_DIALOG_MAX_WIDTH = 72;
const INSPECT_DIALOG_GUTTER = 2;

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
    readonly menu?: boolean;
    readonly copyReady?: boolean;
    readonly copyStatus?: "copied" | "failed";
}

export type TuiDiagnosticsDialogAction =
    | "copy"
    | "dismiss"
    | "back"
    | "open"
    | "previous_scope"
    | "next_scope"
    | "check_health"
    | "consume";

export const DIAGNOSTICS_SCOPES: readonly TuiDiagnosticsScope[] = [
    "session",
    "vera",
];

const DIAGNOSTICS_SCOPE_ROWS: Readonly<
    Record<TuiDiagnosticsScope, { readonly label: string; readonly description: string }>
> = {
    session: {
        label: "Session",
        description: "This conversation: health, processes, usage, model",
    },
    vera: {
        label: "Vera",
        description: "The host: build, startup, extensions, stash",
    },
};

export const DIAGNOSTICS_MENU_HINT = "↑↓ choose · ⏎ open · esc close";

export interface TuiDiagnosticsDialogKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface TuiDiagnosticsDialogView {
    readonly box: BoxRenderable;
    pointer?: DialogRowPointer;
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
    readonly scopeMenu?: boolean;
    readonly emphasis?: "doctor";
}

export function handleTuiDiagnosticsDialogKey(
    key: TuiDiagnosticsDialogKey,
    scoped = false,
    canCheckHealth = false,
    onMenu = false,
): TuiDiagnosticsDialogAction | undefined {
    if (key.ctrl || key.meta) {
        return undefined;
    }
    const enter = key.name === "return"
        || key.name === "enter"
        || key.name === "kpenter";
    if (
        isTuiDialTabKey(key)
        || key.name === "left"
        || key.name === "right"
        || key.name === "space"
    ) {
        return "consume";
    }
    if (scoped && onMenu) {
        if (key.name === "escape") return "dismiss";
        if (enter) return "open";
        if (key.name === "up") return "previous_scope";
        if (key.name === "down") return "next_scope";
        return undefined;
    }
    if (
        canCheckHealth
        && tuiBindingId("diagnostics", key) === "check_provider_health"
    ) {
        return "check_health";
    }
    if (key.shift) return undefined;
    if (key.name === "escape") {
        return scoped ? "back" : "dismiss";
    }
    if (enter) {
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
    const scopeMenu = options.scopeMenu === true
        ? new BoxRenderable(renderer, {
            id: `${id}-scope-menu`,
            width: "100%",
            flexGrow: 1,
            marginTop: 1,
            flexDirection: "column",
            visible: false,
        })
        : undefined;
    let menuRows: BoxRenderable[] = [];
    let markdownStyle = inspectMarkdownStyle();
    let occupancyBlock = 0;
    let healthBlock = 0;
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
        renderNode(token, context) {
            if (
                token.type === "table"
                && token.header.length === 2
                && token.header[0]?.text.trim() === "Field"
                && token.header[1]?.text.trim() === "Value"
            ) {
                const table = context.defaultRender();
                if (table instanceof TextTableRenderable) {
                    table.content = table.content.slice(1);
                }
                return table;
            }
            const raw = token.raw.trimEnd();
            if (HEALTH_TONE_LINE.test(raw)) {
                healthBlock += 1;
                return new TextRenderable(renderer, {
                    id: `${id}-health-${healthBlock}`,
                    content: styledInspectHealth(raw),
                    width: "100%",
                    wrapMode: "char",
                    selectable: true,
                });
            }
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
    if (scopeMenu !== undefined) box.add(scopeMenu);
    box.add(body);
    box.add(footer);
    box.once("destroyed", () => markdownStyle.destroy());
    let activeScope: TuiDiagnosticsScope = "session";
    let onMenu = false;

    const paintMenu = (): void => {
        if (scopeMenu === undefined) return;
        for (const row of menuRows) row.destroyRecursively();
        menuRows = dialogOptionRows(renderer, DIAGNOSTICS_SCOPES.map((scope, index) => ({
            label: DIAGNOSTICS_SCOPE_ROWS[scope].label,
            description: DIAGNOSTICS_SCOPE_ROWS[scope].description,
            active: scope === activeScope,
            current: false,
            ...dialogRowPointer(view.pointer, index),
        })));
        for (const row of menuRows) scopeMenu.add(row);
    };

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
        const available = Math.min(laidOut, frame.width - 4);
        return Math.max(20, available - 1);
    };

    const view: TuiDiagnosticsDialogView = {
        box,
        focus(): void {
            if (onMenu) box.focus();
            else body.focus();
        },
        contentWidth(): number {
            refreshFrame();
            return documentWidth();
        },
        update(state): void {
            refreshFrame();
            if (state.title !== undefined) {
                updateDialogHeaderTitle(header, state.title);
            }
            if (state.footerText !== undefined) {
                shareHint.content = state.footerText;
            }
            if (scopeMenu !== undefined) {
                activeScope = state.scope ?? "session";
                onMenu = state.menu === true;
                scopeMenu.visible = onMenu;
                body.visible = !onMenu;
                updateDialogHeaderTitle(
                    header,
                    onMenu
                        ? defaultTitle
                        : `${defaultTitle} › ${DIAGNOSTICS_SCOPE_ROWS[activeScope].label}`,
                );
                paintMenu();
            }
            bodyMarkdown.content = inspectDocumentMarkdown(
                state.text,
                options.skipFirstLine,
            );
            const back = scopeMenu === undefined ? "" : " · esc back";
            copyHint.content = onMenu && scopeMenu !== undefined
                ? DIAGNOSTICS_MENU_HINT
                : state.copyStatus === "copied"
                ? "✓ copied"
                : state.copyStatus === "failed"
                ? "copy failed · enter retry"
                : state.copyReady === false
                ? options.pendingText ?? "finding session path…"
                : `${INSPECT_COPY_HINT}${back}`;
            copyHint.fg = state.copyStatus === "copied" && !onMenu
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
            paintMenu();
            shareHint.fg = TUI_MUTED;
            copyHint.fg = TUI_MUTED;
        },
    };
    return view;
}

export function inspectMarkdownStyle(): SyntaxStyle {
    return SyntaxStyle.fromStyles({
        default: { fg: TUI_TEXT },
        "markup.heading": { fg: TUI_MUTED, bold: true },
        "markup.heading.1": { fg: TUI_MUTED, bold: true },
        "markup.heading.2": { fg: TUI_MUTED, bold: true },
        "markup.heading.3": { fg: TUI_MUTED, bold: true },
        "markup.strong": { fg: TUI_TEXT, bold: true },
        "markup.italic": { fg: TUI_TEXT, italic: true },
        "markup.raw": { fg: TUI_NOTICE },
        "markup.raw.block": { fg: TUI_NOTICE },
        "markup.list": { fg: TUI_ACCENT },
        "markup.quote": { fg: TUI_MUTED, italic: true },
        "punctuation.special": { fg: TUI_ELEMENT },
        conceal: { fg: TUI_ELEMENT },
    });
}

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

const HEALTH_TONE_LINE =
    /^(?<indent>\s*)(?<tone>green|yellow|red)(?<rest>\s+.*)$/;

export function styledInspectHealth(text: string): StyledText {
    const chunks: TextChunk[] = [];
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
        chunks.push(...healthToneChunks(line));
        if (index < lines.length - 1) {
            chunks.push(fg(TUI_TEXT)("\n"));
        }
    }
    return new StyledText(chunks);
}

function healthToneChunks(line: string): TextChunk[] {
    const health = HEALTH_TONE_LINE.exec(line);
    if (health?.groups === undefined) {
        return [fg(TUI_TEXT)(line)];
    }
    const tone = health.groups.tone;
    const color = tone === "green"
        ? TUI_SUCCESS
        : tone === "yellow"
        ? TUI_NOTICE
        : TUI_DANGER;
    return [
        fg(TUI_TEXT)(health.groups.indent ?? ""),
        fg(color)(tone ?? ""),
        fg(TUI_TEXT)(health.groups.rest ?? ""),
    ];
}

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
