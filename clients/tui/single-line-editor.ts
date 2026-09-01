import {
    TextareaRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_ACCENT,
    TUI_INPUT,
    TUI_MUTED,
    TUI_TEXT,
} from "./state.ts";

export interface TuiTextEditorKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly option?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiSingleLineTextareaOptions {
    readonly id: string;
    /** OpenTUI paints an empty field's cursor over its first placeholder cell, so every ordinary field needs a visible placeholder. */
    readonly placeholder: string;
    readonly backgroundColor?: string;
    readonly height?: number;
    readonly marginTop?: number;
}

/** Vera's ordinary one-line fields use OpenTUI's editor directly. Keeping the renderable native is what gives every field the composer's cursor, selection, word movement. */
export function createTuiSingleLineTextarea(
    renderer: RenderContext,
    options: TuiSingleLineTextareaOptions,
): TextareaRenderable {
    const backgroundColor = options.backgroundColor ?? TUI_INPUT;
    return new TextareaRenderable(renderer, {
        id: options.id,
        width: "100%",
        height: options.height ?? 1,
        wrapMode: "none",
        textColor: TUI_TEXT,
        focusedTextColor: TUI_TEXT,
        backgroundColor,
        focusedBackgroundColor: backgroundColor,
        cursorColor: TUI_ACCENT,
        placeholderColor: TUI_MUTED,
        placeholder: options.placeholder,
        ...(options.marginTop === undefined
            ? {}
            : { marginTop: options.marginTop }),
    });
}

/** Convert Vera's key shape to the native OpenTUI editor event. */
export function tuiTextareaKey(
    key: TuiTextEditorKey,
): Parameters<TextareaRenderable["handleKeyPress"]>[0] {
    return {
        ...key,
        name: key.name === "enter" ? "return" : key.name,
        sequence: key.sequence ?? "",
        ctrl: key.ctrl ?? false,
        meta: key.meta ?? false,
        shift: key.shift ?? false,
        option: key.option ?? false,
        super: key.super ?? false,
        hyper: key.hyper ?? false,
        number: false,
        raw: key.sequence ?? "",
        eventType: "press",
        source: "raw",
    } as Parameters<TextareaRenderable["handleKeyPress"]>[0];
}

export function insertTuiSingleLinePaste(
    editor: TextareaRenderable,
    text: string,
): boolean {
    const pasted = text.replaceAll(/[\u0000-\u001f\u007f]/g, "");
    if (pasted.length === 0) return false;
    editor.insertText(pasted);
    return true;
}

/** Replace a field's text without guessing OpenTUI's display-cell offsets. */
export function syncTuiSingleLineTextarea(
    editor: TextareaRenderable,
    value: string,
    cursor?: number,
): void {
    if (editor.plainText === value) return;
    editor.setText(value);
    if (cursor === undefined) {
        editor.gotoBufferEnd();
        return;
    }
    editor.cursorOffset = Math.max(
        0,
        Math.min(cursor, Bun.stringWidth(value)),
    );
}
