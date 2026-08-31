import {
    bg,
    BoxRenderable,
    bold,
    fg,
    ScrollBoxRenderable,
    StyledText,
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
    TUI_DANGER,
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
import { doctorLineEmphasis } from "../process-doctor.ts";

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
    | "switch_scope"
    | "check_health";

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
    canCheckHealth = false,
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
    if (
        canCheckHealth
        && tuiBindingId("diagnostics", key) === "check_provider_health"
    ) {
        return "check_health";
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
    const bodyText = new TextRenderable(renderer, {
        id: `${id}-text`,
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "none",
        selectable: true,
    });
    const body = new ScrollBoxRenderable(renderer, {
        id: `${id}-body`,
        width: "100%",
        flexGrow: 1,
        minHeight: 1,
        marginTop: 1,
        scrollY: true,
        // Horizontal scroll is a backstop when one line still overflows.
        // Reports reflow to the body width so that path stays unused.
        scrollX: true,
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
    let activeScope: TuiDiagnosticsScope = "session";

    return {
        box,
        focus(): void {
            body.focus();
        },
        contentWidth(): number {
            const frame = inspectDialogFrame(renderer.width);
            box.left = frame.left;
            box.width = frame.width;
            const laidOut = typeof body.width === "number" && body.width > 1
                ? body.width
                : frame.width - 4;
            // Leave the vertical scrollbar column out of the document width so
            // a full-width occupancy bar does not force horizontal scroll.
            return Math.max(20, laidOut - 1);
        },
        update(state): void {
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
            bodyText.content = styledInspectDocument(state.text, {
                skipFirstLine: options.skipFirstLine,
                emphasis: options.emphasis,
            });
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
            bodyText.fg = TUI_TEXT;
            if (scopeTabs !== undefined) {
                scopeTabs.content = diagnosticsScopeTabs(activeScope);
            }
            shareHint.fg = TUI_MUTED;
            copyHint.fg = TUI_MUTED;
        },
    };
}

function diagnosticsScopeTabs(scope: TuiDiagnosticsScope): StyledText {
    // The marker is what survives a monochrome render; the fill decorates it.
    const tab = (label: string, active: boolean) =>
        active
            ? [
                // The fill already opens with a space, so the marker column is
                // one character wide and the two labels stay aligned.
                fg(TUI_ACCENT)("\u203a"),
                bold(fg(TUI_SELECTION_TEXT)(bg(TUI_ACCENT)(` ${label} `))),
            ]
            : [fg(TUI_MUTED)(" "), fg(TUI_MUTED)(` ${label} `)];
    return new StyledText([
        ...tab("Session", scope === "session"),
        fg(TUI_MUTED)("  "),
        ...tab("Vera", scope === "vera"),
        fg(TUI_MUTED)("    tab switch"),
    ]);
}

interface InspectStyleOptions {
    readonly skipFirstLine?: boolean | undefined;
    readonly emphasis?: "doctor" | undefined;
}

/**
 * The inspect dialog is a markdown document. Headings, tables, and quotes stay
 * in the text so a dragged selection copies the source, not a restyled costume.
 * Color is decoration: occupancy cells match the status ctx meter.
 */
export function styledInspectDocument(
    text: string,
    options: InspectStyleOptions = {},
): StyledText {
    const lines = inspectDocumentLines(text, options.skipFirstLine);
    return new StyledText(lines.flatMap((line, index) => {
        const heading = isMarkdownHeading(line);
        const chunks = options.emphasis === "doctor"
            ? styledDoctorLine(line, heading)
            : styledInspectLine(line, heading);
        return index === lines.length - 1
            ? chunks
            : [...chunks, fg(TUI_TEXT)("\n")];
    }));
}

function styledInspectLine(line: string, heading: boolean) {
    if (heading) return [bold(fg(TUI_ACCENT)(line))];
    if (/^─+$/.test(line)) return [fg(TUI_MUTED)(line)];
    if (line.startsWith("> !") || line.startsWith("!  ")) {
        return [fg(TUI_NOTICE)(line)];
    }
    if (line.startsWith("/context")) return [fg(TUI_MUTED)(line)];
    const health = HEALTH_TONE_LINE.exec(line);
    if (health?.groups !== undefined) {
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
    return occupancyGlyphChunks(line);
}

const HEALTH_TONE_LINE =
    /^(?<indent>\s+)(?<tone>green|yellow|red)(?<rest>\s+.*)$/;

function occupancyGlyphChunks(line: string): TextChunk[] {
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
    for (const character of Array.from(line)) {
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
    return chunks.length === 0 ? [fg(TUI_TEXT)(line)] : chunks;
}

/** Visible inspect-dialog body: the markdown, optionally without the H1 title. */
export function inspectDocumentLines(
    text: string,
    skipFirstLine?: boolean,
): string[] {
    return text.split("\n").slice(skipFirstLine === false ? 0 : 1);
}

function isMarkdownHeading(line: string): boolean {
    return /^#{1,6} /.test(line);
}

const INVENTORY_ROLE_LINE =
    /^(?<indent>\s+)(?<role>TUI|host|worker|supervisor|watchdog)(?<rest>\s+PID \d+.*)$/;

function styledDoctorLine(line: string, heading: boolean) {
    if (heading || doctorLineEmphasis(line) === "heading") {
        return [bold(fg(TUI_ACCENT)(line))];
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
    return [fg(TUI_TEXT)(line)];
}

function inventoryRoleColor(role: string): string {
    if (role === "TUI") return TUI_ACCENT;
    if (role === "host") return TUI_TEXT;
    if (role === "worker") return TUI_SUCCESS;
    if (role === "supervisor") return TUI_NOTICE;
    if (role === "watchdog") return TUI_ACCENT;
    return TUI_TEXT;
}
