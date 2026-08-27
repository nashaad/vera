import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_ELEMENT,
    TUI_INPUT,
    TUI_MUTED,
    TUI_TEXT,
} from "./state.ts";

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

/** The notice a closed session shows where its composer would be. */
export const RESUME_OVERLAY_TEXT = "This session is closed.";

/** Every way in, in words: the two that resume this file first. */
export const RESUME_OVERLAY_HINT =
    "enter to resume it · start typing to resume with your message";

/** Ways to start elsewhere without attaching the session on screen. */
export const RESUME_OVERLAY_NEW_HINT =
    "esc home · ctrl+n new · ctrl+r all · ctrl+p commands";

export type JsonlViewKeyAction =
    | "resume"
    | "resume_picker"
    | "scroll"
    | "toggle_sidebar"
    | "sidebar"
    | "new_session"
    | "cycle_session"
    | "palette"
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
 * new chat, open the palette, open a slash command, leave through the rail,
 * go back to home, or do nothing.
 */
export function jsonlViewKeyAction(
    key: JsonlViewKey,
    options: {
        readonly conversationBinding?: string;
        readonly globalBinding?: string;
        readonly workspaceBinding?: string;
        readonly sidebarFocused: boolean;
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
    if (options.sidebarFocused) {
        return "sidebar";
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
    readonly box: BoxRenderable;
    readonly label: TextRenderable;
    readonly hint: TextRenderable;
    applyAppearance(appearance: {
        readonly marginHorizontal: number;
        readonly paddingHorizontal: number;
        readonly boundaryColor: string;
        readonly backgroundColor: string;
        readonly textColor: string;
        readonly mutedColor: string;
    }): void;
}

export function createTuiResumeOverlayView(
    renderer: RenderContext,
    onResume: () => void,
): TuiResumeOverlayView {
    const label = new TextRenderable(renderer, {
        id: "resume-overlay-label",
        content: RESUME_OVERLAY_TEXT,
        fg: TUI_TEXT,
        width: "100%",
        height: 1,
    });
    const hint = new TextRenderable(renderer, {
        id: "resume-overlay-new",
        content: RESUME_OVERLAY_NEW_HINT,
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "resume-overlay",
        border: true,
        borderStyle: "rounded",
        borderColor: TUI_ELEMENT,
        focusedBorderColor: TUI_ELEMENT,
        backgroundColor: TUI_INPUT,
        height: 5,
        paddingLeft: 1,
        paddingRight: 1,
        marginLeft: 2,
        marginRight: 2,
        marginBottom: 2,
        flexDirection: "column",
        focusable: true,
        visible: false,
        onMouseDown: () => {
            onResume();
        },
    });
    const ways = new TextRenderable(renderer, {
        id: "resume-overlay-ways",
        content: RESUME_OVERLAY_HINT,
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
    });
    box.add(label);
    box.add(ways);
    box.add(hint);
    return {
        box,
        label,
        hint,
        applyAppearance(appearance) {
            box.marginLeft = appearance.marginHorizontal;
            box.marginRight = appearance.marginHorizontal;
            box.paddingLeft = appearance.paddingHorizontal;
            box.paddingRight = appearance.paddingHorizontal;
            box.borderColor = appearance.boundaryColor;
            box.focusedBorderColor = appearance.boundaryColor;
            box.backgroundColor = appearance.backgroundColor;
            label.fg = appearance.textColor;
            ways.fg = appearance.mutedColor;
            hint.fg = appearance.mutedColor;
        },
    };
}
