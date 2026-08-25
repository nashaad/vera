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

/** Bracketed so the affordance still reads without color. */
export const RESUME_OVERLAY_LABEL = "[resume]";

/** The key that starts the worker. */
export const RESUME_OVERLAY_HINT = "enter";

export const RESUME_OVERLAY_TEXT =
    `${RESUME_OVERLAY_LABEL} · ${RESUME_OVERLAY_HINT}`;

/** New chat from a file view, because slash commands are blocked. */
export const RESUME_OVERLAY_NEW_HINT = "ctrl+n new";

export type JsonlViewKeyAction =
    | "resume"
    | "scroll"
    | "toggle_sidebar"
    | "sidebar"
    | "new_session"
    | "cycle_session"
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
 * Scroll the transcript, resume, start a new chat, leave through the rail,
 * or nothing. The HUD, palette, slash commands, and typing wait until the
 * file is a session again.
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
    if (options.sidebarFocused) {
        return "sidebar";
    }
    if (isUnmodifiedEnter(key)) {
        return "resume";
    }
    return "block";
}

export function isJsonlViewScrollId(
    binding: string | undefined,
): binding is JsonlViewScrollId {
    return binding !== undefined
        && (JSONL_VIEW_SCROLL_IDS as readonly string[]).includes(binding);
}

function isUnmodifiedEnter(key: JsonlViewKey): boolean {
    return (key.name === "return" || key.name === "enter")
        && key.ctrl !== true
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
        height: 4,
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
    box.add(label);
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
            hint.fg = appearance.mutedColor;
        },
    };
}
