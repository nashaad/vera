import { BoxRenderable, type RenderContext, type TextareaRenderable } from "@opentui/core";

import { TUI_ACCENT, TUI_ELEMENT, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./palette.ts";
import { createTuiSingleLineTextarea, syncTuiSingleLineTextarea } from "./single-line-editor.ts";
import { mixHex } from "./theme.ts";

export type TuiDialogSearchStyle = "border" | "fill" | "plain";
export const DIALOG_SEARCH_HEIGHT = 3;

export interface DialogSearchNode {
    readonly renderer: RenderContext;
    readonly box: BoxRenderable;
    readonly editor: TextareaRenderable;
}

const styles = new WeakMap<RenderContext, TuiDialogSearchStyle>();
const fields = new Set<DialogSearchNode>();

export function configureDialogSearch(renderer: RenderContext, style: TuiDialogSearchStyle): void {
    styles.set(renderer, style);
    for (const field of fields) {
        if (field.renderer === renderer) applySearchChrome(field);
    }
}

export function dialogSearchHeight(renderer: RenderContext): number {
    return styles.get(renderer) === "plain" ? 1 : DIALOG_SEARCH_HEIGHT;
}

function applySearchChrome(field: DialogSearchNode): void {
    const style = styles.get(field.renderer) ?? "fill";
    const filled = style === "fill";
    const plain = style === "plain";
    const background = filled ? TUI_ELEMENT : "transparent";
    field.box.borderColor = mixHex(TUI_PANEL, TUI_TEXT, 0.30);
    // Border color enables an outline in OpenTUI, so select the style afterward.
    field.box.border = style === "border";
    field.box.height = dialogSearchHeight(field.renderer);
    field.box.backgroundColor = background;
    field.box.paddingTop = filled ? 1 : 0;
    field.box.paddingBottom = filled ? 1 : 0;
    field.box.paddingLeft = plain ? 0 : filled ? 2 : 1;
    field.box.paddingRight = plain ? 0 : filled ? 2 : 1;
    field.editor.backgroundColor = background;
    field.editor.focusedBackgroundColor = background;
    field.editor.textColor = TUI_TEXT;
    field.editor.focusedTextColor = TUI_TEXT;
    field.editor.placeholderColor = TUI_MUTED;
    field.editor.cursorColor = TUI_ACCENT;
}

export function refreshDialogSearch(): void {
    for (const field of fields) applySearchChrome(field);
}

export function createDialogSearchNode(
    renderer: RenderContext,
    id: string,
): DialogSearchNode {
    const box = new BoxRenderable(renderer, {
        id: `${id}-frame`, width: "100%", height: DIALOG_SEARCH_HEIGHT,
        marginTop: 1, marginBottom: 1, flexShrink: 0, borderStyle: "single",
    });
    const editor = createTuiSingleLineTextarea(renderer, { id, placeholder: "Search" });
    box.add(editor);
    box.onMouseDown = (event) => { if (event.button === 0) editor.focus(); };
    const field = { renderer, box, editor };
    fields.add(field);
    box.once("destroyed", () => fields.delete(field));
    applySearchChrome(field);
    return field;
}

export function updateDialogSearchNode(
    node: DialogSearchNode,
    query: string,
    placeholder = "Search",
    live = true,
    cursor = query.length,
): void {
    applySearchChrome(node);
    node.editor.placeholder = placeholder;
    syncTuiSingleLineTextarea(node.editor, query, cursor);
    if (!live) node.editor.blur();
}
