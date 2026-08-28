import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
    type Renderable,
} from "@opentui/core";

import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_INPUT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    TUI_COMPOSER_MIN_TEXT_ROWS,
    TUI_COMPOSER_PANEL_ROWS,
} from "./composer.ts";

/**
 * Transcript movement that still works while a conversation is only a file.
 * Ctrl+up/down are the line chords; half-page and jump-to-bottom are the
 * same job at a larger grain.
 */
export const JSONL_VIEW_SCROLL_IDS = [
    "scroll_line_up",
    "scroll_line_down",
    "scroll_half_page_up",
    "scroll_half_page_down",
    "jump_to_bottom",
] as const;

export type JsonlViewScrollId = (typeof JSONL_VIEW_SCROLL_IDS)[number];

/**
 * The one line in the composer slot.
 *
 * It names the two ways back into the conversation and nothing else: the slot
 * is where a person's attention already is, so anything further from the task
 * belongs above it rather than inside it.
 */
export const RESUME_OVERLAY_TEXT =
    "Start typing or enter to continue this session";

/**
 * Why the screen looks quieter than a live one.
 *
 * Typing wakes the conversation, so this is not a door to open: it says what
 * the state is, says it ends by itself, and gets out of the way.
 */
export const IDLE_NOTICE_PROSE =
    "This conversation is idle. It picks up where it left off as soon as you "
    + "type, and a few in-session actions stay quiet until then.";

export interface IdleNoticeChord {
    readonly key: string;
    readonly label: string;
}

/** Ways to start elsewhere without waking the conversation on screen. */
export const IDLE_NOTICE_CHORDS: readonly IdleNoticeChord[] = [
    { key: "esc", label: "home" },
    { key: "ctrl+n", label: "new" },
    { key: "ctrl+r", label: "all" },
    { key: "ctrl+p", label: "commands" },
];

/** The chord row as one string, for a reader that cannot take renderables. */
export const IDLE_NOTICE_CHORD_LINE = IDLE_NOTICE_CHORDS
    .map((chord) => `${chord.key} ${chord.label}`)
    .join(" · ");

/**
 * The prose broken to the columns it has.
 *
 * Never fewer than one line, so the block keeps its height on a terminal too
 * narrow to hold a word.
 */
export function idleNoticeProseLines(columns: number): readonly string[] {
    const width = Math.max(8, Math.floor(columns));
    const lines: string[] = [];
    let line = "";
    for (const word of IDLE_NOTICE_PROSE.split(" ")) {
        const next = line === "" ? word : `${line} ${word}`;
        if (next.length <= width) {
            line = next;
            continue;
        }
        if (line !== "") lines.push(line);
        line = word;
    }
    if (line !== "") lines.push(line);
    return lines.length === 0 ? [""] : lines;
}

export type JsonlViewKeyAction =
    | "resume"
    | "resume_picker"
    | "scroll"
    | "toggle_sidebar"
    | "focus_sidebar"
    | "sidebar"
    | "new_session"
    | "cycle_session"
    | "palette"
    | "search"
    | "command"
    | "type"
    | "home"
    | "block";

export interface JsonlViewKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly meta?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

/**
 * What a key does while the on-screen conversation is a session file.
 *
 * Scroll the transcript, resume (Enter, or any printable key, which resumes
 * with that key as the first character), open the full session list, start a
 * new chat, open the palette or search, open a slash command, leave through
 * the rail, go back to home, or do nothing.
 */
export function jsonlViewKeyAction(
    key: JsonlViewKey,
    options: {
        readonly conversationBinding?: string;
        readonly globalBinding?: string;
        readonly workspaceBinding?: string;
        readonly unfocusedBinding?: string;
        readonly sidebarFocused: boolean;
        /** Whether a rail is drawn beside the file, focused or not. */
        readonly sidebarVisible?: boolean;
    },
): JsonlViewKeyAction {
    if (isJsonlViewScrollId(options.conversationBinding)) {
        return "scroll";
    }
    if (options.globalBinding === "toggle_workspace_sidebar") {
        return "toggle_sidebar";
    }
    if (
        options.globalBinding === "cycle_live_session_next"
        || options.globalBinding === "cycle_live_session_prev"
    ) {
        return "cycle_session";
    }
    if (options.workspaceBinding === "workspace_new_session") {
        return "new_session";
    }
    if (options.globalBinding === "open_palette") {
        return "palette";
    }
    if (
        options.globalBinding === "search_conversation"
        || options.globalBinding === "search_sessions"
    ) {
        return "search";
    }
    if (options.sidebarFocused) {
        return "sidebar";
    }
    // A file claims every key, so the switch into the rail beside it has to be
    // named here or Tab would be swallowed like any other unhandled key.
    if (
        options.sidebarVisible === true
        && options.unfocusedBinding === "focus_composer"
    ) {
        return "focus_sidebar";
    }
    if (options.workspaceBinding === "workspace_resume_picker") {
        return "resume_picker";
    }
    if (isUnmodifiedEnter(key)) {
        return "resume";
    }
    if (isPrintable(key)) {
        return key.name === "/" ? "command" : "type";
    }
    // Nothing here is being edited, so Escape has no draft to clear and can
    // mean the one thing it means everywhere else: back out of this.
    if (isUnmodified(key) && key.name === "escape") {
        return "home";
    }
    return "block";
}

function isPrintable(key: JsonlViewKey): boolean {
    return (key.name.length === 1 || key.name === "space")
        && key.ctrl !== true
        && key.meta !== true
        && key.super !== true
        && key.hyper !== true;
}

export function isJsonlViewScrollId(
    binding: string | undefined,
): binding is JsonlViewScrollId {
    return binding !== undefined
        && (JSONL_VIEW_SCROLL_IDS as readonly string[]).includes(binding);
}

function isUnmodifiedEnter(key: JsonlViewKey): boolean {
    return (key.name === "return" || key.name === "enter")
        && isUnmodified(key);
}

function isUnmodified(key: JsonlViewKey): boolean {
    return key.ctrl !== true
        && key.shift !== true
        && key.meta !== true
        && key.super !== true
        && key.hyper !== true;
}

export interface TuiResumeOverlayView {
    /** The band and the composer-shaped slot together, as one column. */
    readonly surface: BoxRenderable;
    readonly box: BoxRenderable;
    readonly label: TextRenderable;
    /**
     * Re-breaks the prose to the columns the chat has and returns whether the
     * band changed height, which is what the layout around it has to know.
     */
    setColumns(columns: number): boolean;
    /**
     * Moves the caret's blink to where the given clock reading puts it. Cheap
     * enough to call on every tick: it writes only when the phase turns over.
     */
    blink(now: number): void;
    applyAppearance(appearance: {
        readonly marginHorizontal: number;
        readonly paddingHorizontal: number;
        readonly boundaryColor: string;
        readonly backgroundColor: string;
        readonly noticeColor: string;
        readonly textColor: string;
        readonly mutedColor: string;
        readonly accentColor: string;
    }): void;
}

/** Rows the band spends on something other than a line of its own text. */
const NOTICE_CHROME_ROWS = 4;

/** The row between the prose and the chords. */
const NOTICE_GAP_ROWS = 1;

/** Bold: the chord is the part a reader acts on. */
const CHORD_ATTRIBUTES = 1;

/** Where typing would go. */
export const RESUME_CARET = "› ";

/** A caret that held still would read as a glyph rather than as a cursor. */
export const RESUME_CARET_BLINK_MS = 530;

/**
 * Whether the caret is drawn at this reading of the clock.
 *
 * The phase comes off the clock rather than off a counter so a redraw that
 * skipped a tick, or one that ran twice, lands where the eye expects it.
 */
export function resumeCaretVisible(now: number): boolean {
    return Math.floor(now / RESUME_CARET_BLINK_MS) % 2 === 0;
}

/** The columns one chord takes, separator included for all but the first. */
function chordColumns(chord: IdleNoticeChord, first: boolean): number {
    return chord.key.length + 1 + chord.label.length + (first ? 0 : 3);
}

/**
 * The chords that fit, in order, dropping from the right.
 *
 * A row that runs off its own edge reads as a chord that was cut in half, so
 * the last ones are left out rather than half-drawn. Escape leads because it
 * is the one every other screen also answers.
 */
export function idleNoticeChordsFor(
    columns: number,
): readonly IdleNoticeChord[] {
    const kept: IdleNoticeChord[] = [];
    let used = 0;
    for (const chord of IDLE_NOTICE_CHORDS) {
        const width = chordColumns(chord, kept.length === 0);
        if (used + width > columns) break;
        used += width;
        kept.push(chord);
    }
    return kept;
}

export function createTuiResumeOverlayView(
    renderer: RenderContext,
    onResume: () => void,
): TuiResumeOverlayView {
    let colors = {
        textColor: TUI_TEXT,
        mutedColor: TUI_MUTED,
        noticeColor: TUI_PANEL,
        accentColor: TUI_ACCENT,
        backgroundColor: TUI_INPUT,
    };
    let columns = 80;
    let indent = 3;
    let caretOn = true;
    // The slot is built out of the composer's own parts at the composer's own
    // measurements: a person looking at it should not be able to tell that
    // this is a different thing until they read it.
    const caret = new TextRenderable(renderer, {
        id: "resume-overlay-caret",
        content: RESUME_CARET,
        fg: TUI_ACCENT,
        bg: TUI_INPUT,
        flexShrink: 0,
    });
    const label = new TextRenderable(renderer, {
        id: "resume-overlay-label",
        content: RESUME_OVERLAY_TEXT,
        fg: TUI_TEXT,
        bg: TUI_INPUT,
        flexGrow: 1,
    });
    const line = new BoxRenderable(renderer, {
        id: "resume-overlay-line",
        width: "100%",
        height: 1,
        flexDirection: "row",
        backgroundColor: TUI_INPUT,
        flexShrink: 0,
    });
    line.add(caret);
    line.add(label);
    const filler = new BoxRenderable(renderer, {
        id: "resume-overlay-filler",
        width: "100%",
        height: TUI_COMPOSER_MIN_TEXT_ROWS - 1,
        backgroundColor: TUI_INPUT,
        flexShrink: 0,
    });
    const rule = new BoxRenderable(renderer, {
        id: "resume-overlay-rule",
        border: ["top"],
        borderColor: TUI_ELEMENT,
        focusedBorderColor: TUI_ELEMENT,
        width: "100%",
        height: 1,
        flexShrink: 0,
    });
    const status = new TextRenderable(renderer, {
        id: "resume-overlay-status",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        flexShrink: 0,
    });
    const box = new BoxRenderable(renderer, {
        id: "resume-overlay",
        border: true,
        borderStyle: "rounded",
        borderColor: TUI_ELEMENT,
        focusedBorderColor: TUI_ELEMENT,
        backgroundColor: TUI_INPUT,
        height: TUI_COMPOSER_PANEL_ROWS,
        paddingLeft: 1,
        paddingRight: 1,
        marginLeft: 2,
        marginRight: 2,
        flexDirection: "column",
        focusable: true,
        onMouseDown: () => {
            onResume();
        },
    });
    box.add(line);
    box.add(filler);
    box.add(rule);
    box.add(status);
    // Tinted and edge to edge, like the transcript's own blocks, but on the
    // panel ground rather than the one a user message uses and with no caret:
    // this is the room talking, not something anybody said.
    const notice = new BoxRenderable(renderer, {
        id: "resume-overlay-notice",
        border: false,
        width: "100%",
        height: NOTICE_CHROME_ROWS + 2,
        backgroundColor: TUI_PANEL,
        paddingTop: 1,
        paddingBottom: 1,
        marginBottom: 1,
        flexDirection: "column",
    });
    const surface = new BoxRenderable(renderer, {
        id: "resume-overlay-surface",
        border: false,
        width: "100%",
        height: NOTICE_CHROME_ROWS + 2 + TUI_COMPOSER_PANEL_ROWS,
        marginBottom: 2,
        flexDirection: "column",
        visible: false,
    });
    surface.add(notice);
    surface.add(box);
    let painted: Renderable[] = [];
    const paint = (): boolean => {
        for (const node of painted) node.destroyRecursively();
        painted = [];
        const add = (node: Renderable): void => {
            painted.push(node);
            notice.add(node);
        };
        const room = Math.max(8, columns - indent * 2);
        const lines = idleNoticeProseLines(room);
        for (const [index, text] of lines.entries()) {
            add(new TextRenderable(renderer, {
                id: `resume-overlay-notice-${index}`,
                content: text,
                fg: colors.mutedColor,
                bg: colors.noticeColor,
                width: "100%",
                height: 1,
            }));
        }
        add(new TextRenderable(renderer, {
            id: "resume-overlay-notice-gap",
            content: "",
            bg: colors.noticeColor,
            width: "100%",
            height: 1,
        }));
        // The chords sit on one row of their own so each can be drawn heavier
        // than the word beside it: one text renderable takes one colour.
        const chordRow = new BoxRenderable(renderer, {
            id: "resume-overlay-chords",
            width: "100%",
            height: 1,
            backgroundColor: colors.noticeColor,
            flexDirection: "row",
        });
        for (const [index, chord] of idleNoticeChordsFor(room).entries()) {
            if (index > 0) {
                chordRow.add(new TextRenderable(renderer, {
                    id: `resume-overlay-chord-gap-${index}`,
                    content: " · ",
                    fg: colors.mutedColor,
                    bg: colors.noticeColor,
                }));
            }
            chordRow.add(new TextRenderable(renderer, {
                id: `resume-overlay-chord-key-${index}`,
                content: chord.key,
                fg: colors.textColor,
                bg: colors.noticeColor,
                attributes: CHORD_ATTRIBUTES,
            }));
            chordRow.add(new TextRenderable(renderer, {
                id: `resume-overlay-chord-word-${index}`,
                content: ` ${chord.label}`,
                fg: colors.mutedColor,
                bg: colors.noticeColor,
            }));
        }
        add(chordRow);
        const height = NOTICE_CHROME_ROWS + lines.length;
        const changed = notice.height !== height;
        notice.height = height;
        surface.height = height + 1 + TUI_COMPOSER_PANEL_ROWS;
        return changed;
    };
    paint();
    return {
        surface,
        box,
        label,
        setColumns(next): boolean {
            const width = Math.max(8, Math.floor(next));
            if (width === columns) return false;
            columns = width;
            return paint();
        },
        blink(now): void {
            const on = resumeCaretVisible(now);
            if (on === caretOn) return;
            caretOn = on;
            caret.content = on ? RESUME_CARET : " ".repeat(RESUME_CARET.length);
        },
        applyAppearance(appearance) {
            colors = {
                textColor: appearance.textColor,
                mutedColor: appearance.mutedColor,
                noticeColor: appearance.noticeColor,
                accentColor: appearance.accentColor,
                backgroundColor: appearance.backgroundColor,
            };
            box.marginLeft = appearance.marginHorizontal;
            box.marginRight = appearance.marginHorizontal;
            box.paddingLeft = appearance.paddingHorizontal;
            box.paddingRight = appearance.paddingHorizontal;
            box.borderColor = appearance.boundaryColor;
            box.focusedBorderColor = appearance.boundaryColor;
            box.backgroundColor = appearance.backgroundColor;
            rule.borderColor = appearance.boundaryColor;
            rule.focusedBorderColor = appearance.boundaryColor;
            for (const part of [line, filler]) {
                part.backgroundColor = appearance.backgroundColor;
            }
            label.fg = appearance.textColor;
            label.bg = appearance.backgroundColor;
            caret.fg = appearance.accentColor;
            caret.bg = appearance.backgroundColor;
            status.fg = appearance.mutedColor;
            notice.backgroundColor = appearance.noticeColor;
            // The band runs to both edges, so only its own padding holds the
            // prose in: set that to where the composer's text starts and the
            // two read as one column despite the different widths.
            indent = appearance.marginHorizontal + appearance.paddingHorizontal
                + 1;
            notice.paddingLeft = indent;
            notice.paddingRight = indent;
            paint();
        },
    };
}
