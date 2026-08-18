import {
    BoxRenderable,
    bold,
    fg,
    ScrollBoxRenderable,
    StyledText,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    DIALOG_CARD_Z_INDEX,
    dialogHeaderNode,
} from "./dialog-chrome.ts";
import {
    TUI_MUTED,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";

export interface TuiDiagnosticsDialogState {
    readonly text: string;
    readonly copyReady?: boolean;
    readonly copyStatus?: "copied" | "failed";
}

export type TuiDiagnosticsDialogAction = "copy" | "dismiss";

export interface TuiDiagnosticsDialogKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface TuiDiagnosticsDialogView {
    readonly box: BoxRenderable;
    focus(): void;
    update(state: TuiDiagnosticsDialogState): void;
    repaint(): void;
}

export interface TuiDiagnosticsDialogOptions {
    readonly id?: string;
    readonly title?: string;
    readonly footerText?: string;
    readonly pendingText?: string;
    readonly sections?: ReadonlySet<string>;
    readonly skipFirstLine?: boolean;
}

export function handleTuiDiagnosticsDialogKey(
    key: TuiDiagnosticsDialogKey,
): TuiDiagnosticsDialogAction | undefined {
    if (key.ctrl || key.meta || key.shift) {
        return undefined;
    }
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
    const box = new BoxRenderable(renderer, {
        id,
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: "6%",
        left: "4%",
        width: "92%",
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
    const header = dialogHeaderNode(renderer, options.title ?? "Diagnostics");
    const bodyText = new TextRenderable(renderer, {
        id: `${id}-text`,
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        selectable: true,
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
    body.add(bodyText);
    const footer = new BoxRenderable(renderer, {
        id: `${id}-footer`,
        width: "100%",
        height: 2,
        marginTop: 1,
        flexDirection: "row",
        justifyContent: "space-between",
    });
    const shareHint = new TextRenderable(renderer, {
        content: options.footerText ?? "Share this when reporting an issue.",
        fg: TUI_MUTED,
        height: 1,
    });
    const copyHint = new TextRenderable(renderer, {
        content: "copy  enter",
        fg: TUI_MUTED,
        height: 1,
    });
    footer.add(shareHint);
    footer.add(copyHint);
    box.add(header);
    box.add(body);
    box.add(footer);

    return {
        box,
        focus(): void {
            body.focus();
        },
        update(state): void {
            bodyText.content = styledDiagnostics(state.text, {
                sections: options.sections,
                skipFirstLine: options.skipFirstLine,
            });
            copyHint.content = state.copyStatus === "copied"
                ? "✓ copied"
                : state.copyStatus === "failed"
                ? "copy failed · enter retry"
                : state.copyReady === false
                ? options.pendingText ?? "finding session path…"
                : "copy  enter";
            copyHint.fg = state.copyStatus === "copied"
                ? TUI_SUCCESS
                : TUI_MUTED;
        },
        repaint(): void {
            box.backgroundColor = TUI_PANEL;
            bodyText.fg = TUI_MUTED;
            shareHint.fg = TUI_MUTED;
            copyHint.fg = TUI_MUTED;
        },
    };
}

const DIAGNOSTIC_SECTIONS = new Set([
    "## Build",
    "## Startup",
    "## Session usage",
    "## Startup extensions",
    "## Extensions",
    "## Runtime",
    "## Model",
    "## Session",
    "## Pre-image stash",
]);

interface DiagnosticsStyleOptions {
    readonly sections?: ReadonlySet<string> | undefined;
    readonly skipFirstLine?: boolean | undefined;
}

/** Low-contrast report text with just enough hierarchy to scan quickly. */
export function styledDiagnostics(
    text: string,
    options: DiagnosticsStyleOptions = {},
): StyledText {
    const lines = terminalDiagnosticsLines(text.split("\n").slice(
        options.skipFirstLine === false ? 0 : 1,
    ));
    const sections = options.sections ?? DIAGNOSTIC_SECTIONS;
    return new StyledText(lines.flatMap((line, index) => {
        const heading = sections.has(line) || line.startsWith("### ");
        const content = heading
            ? bold(fg(TUI_TEXT)(line.replace(/^#{2,3} /, "")))
            : fg(TUI_MUTED)(line);
        return index === lines.length - 1
            ? [content]
            : [content, fg(TUI_MUTED)("\n")];
    }));
}

/** Keeps copied diagnostics as Markdown while presenting native terminal text. */
export function terminalDiagnosticsLines(lines: readonly string[]): string[] {
    const rendered: string[] = [];
    for (let index = 0; index < lines.length;) {
        const cells = markdownRow(lines[index]);
        const separator = markdownRow(lines[index + 1]);
        if (
            cells !== undefined
            && separator?.every((cell) => /^:?-{3,}:?$/.test(cell))
        ) {
            const rows: string[][] = [cells];
            index += 2;
            while (index < lines.length) {
                const next = markdownRow(lines[index]);
                if (next === undefined) break;
                rows.push(next);
                index += 1;
            }
            rendered.push(...terminalTable(rows));
            continue;
        }
        const line = lines[index] ?? "";
        rendered.push(line.startsWith("> ") ? `Note: ${line.slice(2)}` : line);
        index += 1;
    }
    return rendered;
}

function markdownRow(line: string | undefined): string[] | undefined {
    if (line === undefined || !line.startsWith("| ") || !line.endsWith(" |")) {
        return undefined;
    }
    return line.slice(2, -2).split(" | ");
}

function terminalTable(rows: readonly (readonly string[])[]): string[] {
    const columns = Math.max(...rows.map((row) => row.length));
    const widths = Array.from({ length: columns }, (_, column) =>
        Math.max(...rows.map((row) => row[column]?.length ?? 0))
    );
    const render = (row: readonly string[]) => row.map((cell, column) =>
        cell.padEnd(widths[column] ?? cell.length)
    ).join("  ").trimEnd();
    return [
        render(rows[0] ?? []),
        widths.map((width) => "─".repeat(width)).join("  "),
        ...rows.slice(1).map(render),
    ];
}
