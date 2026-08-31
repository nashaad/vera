import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    centeredDialogSurface,
    createDialogTextFieldNode,
    updateDialogTextFieldNode,
} from "./dialog-chrome.ts";
import type { TuiSettingsPickerState } from "./settings-picker.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

export interface TuiSessionNameTarget {
    readonly kind: "session";
    readonly sessionId: string;
}

export interface TuiPoolNameTarget {
    readonly kind: "pool";
    readonly provider: string;
    readonly model: string;
}

export type TuiNamePromptTarget = TuiSessionNameTarget | TuiPoolNameTarget;

/**
 * The name line for one row, either a session or a pool entry.
 *
 * Its own overlay rather than the picker's search box: what is typed here
 * names the row, and the picker's box filters the list.
 */
export interface TuiNamePromptState {
    readonly editorSession: number;
    readonly target: TuiNamePromptTarget;
    /** The row as it reads now, which may still be a fallback label. */
    readonly label: string;
    readonly value: string;
    /** The pane this was opened over, restored when it closes. */
    readonly parent?: TuiSettingsPickerState;
}

export interface TuiNamePromptKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiNamePromptTransition {
    readonly state?: TuiNamePromptState;
    readonly handled: boolean;
    /**
     * The requested name on a submit, null to clear it. Absent means the
     * overlay closed without asking for anything.
     */
    readonly submitted?: string | null;
}

export interface TuiNamePromptView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    focus(): void;
    handleKey(
        state: TuiNamePromptState,
        key: TuiNamePromptKey,
    ): TuiNamePromptTransition;
    handlePaste(state: TuiNamePromptState, text: string): TuiNamePromptState;
    update(state: TuiNamePromptState): void;
}

export function startTuiNamePrompt(
    target: TuiNamePromptTarget,
    label: string,
    parent?: TuiSettingsPickerState,
    value = "",
): TuiNamePromptState {
    return {
        editorSession: nextEditorSession++,
        target,
        label,
        value,
        ...(parent === undefined ? {} : { parent }),
    };
}

export function handleTuiNamePromptKey(
    state: TuiNamePromptState,
    key: TuiNamePromptKey,
): TuiNamePromptTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    if (
        (key.name === "return" || key.name === "enter")
        && !key.ctrl && !key.meta && !key.shift && !key.super && !key.hyper
    ) {
        const value = state.value.trim();
        // Submitting an empty field clears the name and restores the
        // first-prompt fallback, which is what bare `/rename` does. Escape is
        // the way out for someone who meant neither.
        return { handled: true, submitted: value.length === 0 ? null : value };
    }
    return { state, handled: false };
}

export function createTuiNamePromptView(
    renderer: RenderContext,
): TuiNamePromptView {
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
    const entry = createDialogTextFieldNode(
        renderer,
        "name-prompt-entry",
        "New name",
    );
    const footer = new TextRenderable(renderer, {
        content: "←→ move · ⏎ save · empty clears · esc cancel",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "name-prompt",
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
    box.add(title);
    box.add(hint);
    box.add(entry);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "name-prompt-surface", box);
    let shownEditorSession: number | undefined;
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(title, { fg: "text" }),
            tuiThemeProperties(hint, { fg: "muted" }),
            tuiThemeProperties(entry, {
                textColor: "text",
                focusedTextColor: "text",
                backgroundColor: "panel",
                focusedBackgroundColor: "panel",
                cursorColor: "accent",
                placeholderColor: "muted",
            }),
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        focus(): void {
            entry.focus();
        },
        handleKey(state, key): TuiNamePromptTransition {
            const current = { ...state, value: entry.plainText };
            const transition = handleTuiNamePromptKey(current, key);
            if (transition.handled) return transition;
            entry.handleKeyPress(tuiTextareaKey(key));
            return {
                state: { ...current, value: entry.plainText },
                // This prompt is modal. Unknown keys stop here instead of
                // reaching the picker hidden underneath it.
                handled: true,
            };
        },
        handlePaste(state, text): TuiNamePromptState {
            insertTuiSingleLinePaste(entry, text);
            return { ...state, value: entry.plainText };
        },
        update(state): void {
            if (shownEditorSession !== state.editorSession) {
                if (entry.plainText !== state.value) {
                    entry.setText(state.value);
                }
                entry.gotoBufferEnd();
                shownEditorSession = state.editorSession;
            }
            const session = state.target.kind === "session";
            title.content = session
                ? "Rename conversation"
                : "Name shortlisted model";
            hint.visible = !session;
            hint.content = session ? "" : state.label;
            updateDialogTextFieldNode(
                entry,
                state.value,
                session ? "New name" : "Name",
            );
        },
    };
}

let nextEditorSession = 1;
