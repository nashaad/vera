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
    TUI_ACCENT,
    TUI_DANGER,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";
import type { TuiDiagnosticsScope } from "./diagnostics.ts";
import { tuiBindingId } from "./keymap.ts";
import { doctorLineEmphasis } from "../process-doctor.ts";

export interface TuiDiagnosticsDialogState {
    readonly text: string;
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
    const scopeTabs = options.showScopeTabs === true
        ? new TextRenderable(renderer, {
            id: `${id}-scope-tabs`,
            content: diagnosticsScopeTabs("session"),
            width: "100%",
            height: 1,
            marginTop: 1,
        })
        : undefined;
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
    if (scopeTabs !== undefined) box.add(scopeTabs);
    box.add(body);
    box.add(footer);
    let activeScope: TuiDiagnosticsScope = "session";

    return {
        box,
        focus(): void {
            body.focus();
        },
        update(state): void {
            if (scopeTabs !== undefined) {
                activeScope = state.scope ?? "session";
                scopeTabs.content = diagnosticsScopeTabs(activeScope);
            }
            bodyText.content = styledDiagnostics(state.text, {
                sections: options.sections,
                skipFirstLine: options.skipFirstLine,
                emphasis: options.emphasis,
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
            if (scopeTabs !== undefined) {
                scopeTabs.content = diagnosticsScopeTabs(activeScope);
            }
            shareHint.fg = TUI_MUTED;
            copyHint.fg = TUI_MUTED;
        },
    };
}

function diagnosticsScopeTabs(scope: TuiDiagnosticsScope): StyledText {
    const session = scope === "session"
        ? bold(fg(TUI_TEXT)("[Session]"))
        : fg(TUI_MUTED)("Session");
    const vera = scope === "vera"
        ? bold(fg(TUI_TEXT)("[Vera]"))
        : fg(TUI_MUTED)("Vera");
    return new StyledText([
        session,
        fg(TUI_MUTED)("  "),
        vera,
        fg(TUI_MUTED)("    tab switch"),
    ]);
}

const DIAGNOSTIC_SECTIONS = new Set([
    "## Build",
    "## Startup",
    "## Session usage",
    "## Processes",
    "## Startup extensions",
    "## Extensions",
    "## Runtime",
    "## Model",
    "## Session",
    "## Model failures",
    "## Pre-image stash",
]);

interface DiagnosticsStyleOptions {
    readonly sections?: ReadonlySet<string> | undefined;
    readonly skipFirstLine?: boolean | undefined;
    readonly emphasis?: "doctor" | undefined;
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
        const chunks = options.emphasis === "doctor"
            ? styledDoctorLine(line, heading)
            : [
                heading
                    ? bold(fg(TUI_TEXT)(line.replace(/^#{2,3} /, "")))
                    : fg(TUI_MUTED)(line),
            ];
        return index === lines.length - 1
            ? chunks
            : [...chunks, fg(TUI_MUTED)("\n")];
    }));
}

const INVENTORY_ROLE_LINE =
    /^(?<indent>\s+)(?<role>TUI|host|worker|supervisor|watchdog)(?<rest>\s+PID \d+.*)$/;

function styledDoctorLine(line: string, heading: boolean) {
    if (heading || doctorLineEmphasis(line) === "heading") {
        return [bold(fg(TUI_TEXT)(line))];
    }
    const tone = doctorLineEmphasis(line);
    if (tone === "success") return [bold(fg(TUI_SUCCESS)(line))];
    if (tone === "danger") return [fg(TUI_DANGER)(line)];
    if (tone === "tally") return [fg(TUI_TEXT)(line)];
    if (tone === "role") {
        const match = INVENTORY_ROLE_LINE.exec(line);
        const role = match?.groups?.role;
        if (match !== null && role !== undefined) {
            return [
                fg(TUI_MUTED)(match.groups?.indent ?? ""),
                fg(inventoryRoleColor(role))(role),
                fg(TUI_MUTED)(match.groups?.rest ?? ""),
            ];
        }
    }
    return [fg(TUI_MUTED)(line)];
}

function inventoryRoleColor(role: string): string {
    if (role === "TUI") return TUI_ACCENT;
    if (role === "host") return TUI_TEXT;
    if (role === "worker") return TUI_SUCCESS;
    if (role === "supervisor") return TUI_NOTICE;
    if (role === "watchdog") return TUI_ACCENT;
    return TUI_TEXT;
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
