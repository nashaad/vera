import {
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_ACCENT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import type { TuiSettingsPickerState } from "./settings-picker.ts";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The name line for one session row.
 *
 * Its own overlay rather than the picker's search box: what is typed here
 * names a session, and the picker's box filters the list.
 */
export interface TuiSessionRenamePromptState {
    readonly sessionId: string;
    /** The row as it reads now, which may still be the first-prompt fallback. */
    readonly label: string;
    readonly value: string;
    /** The pane this was opened over, restored when it closes. */
    readonly parent?: TuiSettingsPickerState;
}

export interface TuiSessionRenamePromptKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiSessionRenamePromptTransition {
    readonly state?: TuiSessionRenamePromptState;
    readonly handled: boolean;
    /**
     * The requested name on a submit, null to clear it. Absent means the
     * overlay closed without asking for anything.
     */
    readonly submitted?: string | null;
}

export interface TuiSessionRenamePromptView {
    readonly box: BoxRenderable;
    update(state: TuiSessionRenamePromptState): void;
}

export function startTuiSessionRenamePrompt(
    session: { readonly sessionId: string; readonly label: string },
    parent?: TuiSettingsPickerState,
): TuiSessionRenamePromptState {
    // The field opens empty rather than holding the current row text: a row
    // with no name of its own reads as its first prompt, and prefilling would
    // offer to save that sentence as the name.
    return {
        sessionId: session.sessionId,
        label: session.label,
        value: "",
        ...(parent === undefined ? {} : { parent }),
    };
}

export function handleTuiSessionRenamePromptPaste(
    state: TuiSessionRenamePromptState,
    text: string,
): TuiSessionRenamePromptState {
    const pasted = text.replaceAll(new RegExp(CONTROL_CHARACTERS, "g"), "")
        .trim();
    return pasted.length === 0
        ? state
        : { ...state, value: state.value + pasted };
}

export function handleTuiSessionRenamePromptKey(
    state: TuiSessionRenamePromptState,
    key: TuiSessionRenamePromptKey,
): TuiSessionRenamePromptTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    // Everything else is swallowed rather than passed down. The pane this is
    // drawn over is a list with its own bindings, and a key that fell through
    // would move a row nobody can see, or reopen this prompt over itself and
    // lose what has been typed. Interrupt and the palette are decided ahead of
    // any overlay, so they are not reachable from here to begin with.
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return { state, handled: true };
    }
    if (key.name === "backspace") {
        return {
            state: { ...state, value: state.value.slice(0, -1) },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const value = state.value.trim();
        // Submitting an empty field clears the name and restores the
        // first-prompt fallback, which is what bare `/rename` does. Escape is
        // the way out for someone who meant neither.
        return { handled: true, submitted: value.length === 0 ? null : value };
    }
    const typed = key.sequence !== undefined && key.sequence.length > 0
        ? key.sequence
        : key.name.length === 1
        ? key.name
        : undefined;
    if (typed === undefined || CONTROL_CHARACTERS.test(typed)) {
        return { state, handled: true };
    }
    return { state: { ...state, value: state.value + typed }, handled: true };
}

export function createTuiSessionRenamePromptView(
    renderer: RenderContext,
): TuiSessionRenamePromptView {
    const title = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        attributes: 1,
        width: "100%",
        height: 1,
    });
    const hint = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
    });
    const entry = new TextRenderable(renderer, {
        content: "",
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "⏎ save · ⏎ on an empty field clears · esc cancel",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "session-rename-prompt",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: 2,
        left: "15%",
        width: "70%",
        height: "auto",
        zIndex: 20,
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
        visible: false,
    });
    box.add(title);
    box.add(hint);
    box.add(entry);
    box.add(footer);
    return {
        box,
        update(state): void {
            title.content = "Rename conversation";
            hint.content = state.label;
            entry.content = tuiSessionRenameEntryLine(state.value);
        },
    };
}

export function tuiSessionRenameEntryLine(value: string): StyledText {
    return new StyledText([
        value.length === 0
            ? fg(TUI_MUTED)("name")
            : fg(TUI_TEXT)(value),
        fg(TUI_ACCENT)("▏"),
    ]);
}
