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
import { DIALOG_CARD_Z_INDEX } from "./dialog-chrome.ts";
import type { TuiSettingsPickerState } from "./settings-picker.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";

export interface TuiSecretPromptState {
    readonly providerId: string;
    readonly label: string;
    readonly hint?: string;
    readonly value: string;
    readonly parent?: TuiSettingsPickerState;
}

export interface TuiSecretPromptKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiSecretPromptTransition {
    readonly state?: TuiSecretPromptState;
    readonly handled: boolean;
    readonly submitted?: string;
}

export interface TuiSecretPromptView {
    readonly box: BoxRenderable;
    readonly card: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    update(state: TuiSecretPromptState): void;
}

export function startTuiSecretPrompt(
    provider: {
        readonly id: string;
        readonly label: string;
        readonly hint?: string;
    },
    parent?: TuiSettingsPickerState,
): TuiSecretPromptState {
    return {
        providerId: provider.id,
        label: provider.label,
        ...(provider.hint === undefined ? {} : { hint: provider.hint }),
        value: "",
        ...(parent === undefined ? {} : { parent }),
    };
}

export function handleTuiSecretPromptPaste(
    state: TuiSecretPromptState,
    text: string,
): TuiSecretPromptState {
    const pasted = text.replaceAll(/[\u0000-\u001f\u007f]/g, "").trim();
    return pasted.length === 0
        ? state
        : { ...state, value: state.value + pasted };
}

export function handleTuiSecretPromptKey(
    state: TuiSecretPromptState,
    key: TuiSecretPromptKey,
): TuiSecretPromptTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    if (tuiBindingId("secret_prompt", key) === "clear_secret") {
        return { state: { ...state, value: "" }, handled: true };
    }
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return { state, handled: false };
    }
    if (key.name === "backspace") {
        return {
            state: { ...state, value: state.value.slice(0, -1) },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const value = state.value.trim();
        return value.length === 0
            ? { handled: true }
            : { handled: true, submitted: value };
    }
    const typed = key.sequence !== undefined && key.sequence.length > 0
        ? key.sequence
        : key.name.length === 1
        ? key.name
        : undefined;
    if (typed === undefined || /[\u0000-\u001f\u007f]/.test(typed.replaceAll(/[\r\n]/g, ""))) {
        return { state, handled: false };
    }
    return {
        state: { ...state, value: state.value + typed.replaceAll(/[\r\n]/g, "") },
        handled: true,
    };
}

export function createTuiSecretPromptView(
    renderer: RenderContext,
): TuiSecretPromptView {
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
        wrapMode: "char",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: `⏎ save · ${tuiKeyHint("clear_secret")} · esc cancel`,
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const card = new BoxRenderable(renderer, {
        id: "secret-prompt-card",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "70%",
        height: "auto",
        maxHeight: "90%",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
    });
    card.add(title);
    card.add(hint);
    card.add(entry);
    card.add(footer);
    const box = new BoxRenderable(renderer, {
        id: "secret-prompt",
        border: false,
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: DIALOG_CARD_Z_INDEX,
        alignItems: "center",
        justifyContent: "center",
        focusable: true,
        visible: false,
    });
    box.add(card);
    return {
        box,
        card,
        themeBindings: [
            tuiThemeProperties(title, { fg: "text" }),
            tuiThemeProperties(hint, { fg: "muted" }),
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(card, { backgroundColor: "panel" }),
        ],
        update(state): void {
            title.content = `${state.label} API key`;
            hint.content = state.hint ?? "";
            entry.content = tuiSecretEntryLine(state.value);
        },
    };
}

export function tuiSecretEntryLine(value: string): StyledText {
    return new StyledText([
        value.length === 0 ? fg(TUI_MUTED)("API key") : fg(TUI_TEXT)(value),
        fg(TUI_ACCENT)("▏"),
    ]);
}
