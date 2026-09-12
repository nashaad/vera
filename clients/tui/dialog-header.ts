import { BoxRenderable, RGBA, TextRenderable, type Renderable, type RenderContext } from "@opentui/core";

import { TUI_CHROME, TUI_MUTED, TUI_NOTICE, TUI_PANEL, TUI_TEXT } from "./palette.ts";
import { mixHex } from "./theme.ts";

export type TuiDialogHeaderStyle = "underline" | "box";
export const DIALOG_HEADER_HEIGHT = 3;

interface DialogHeaderRecord {
    compact: boolean;
    readonly renderer: RenderContext;
    readonly box: BoxRenderable;
    readonly title: TextRenderable;
    readonly marker: TextRenderable;
    readonly hint: TextRenderable;
    readonly plainHint: string;
    readonly suppliedTitle: boolean;
}

const styles = new WeakMap<RenderContext, TuiDialogHeaderStyle>();
const headers = new Set<DialogHeaderRecord>();
const titles = new WeakMap<BoxRenderable, TextRenderable>();
let nextHeader = 0;

export function configureDialogHeaders(renderer: RenderContext, style: TuiDialogHeaderStyle): void {
    styles.set(renderer, style);
    for (const header of headers) {
        if (header.renderer === renderer) applyHeaderChrome(header);
    }
}

export function updateDialogHeaderTitle(header: BoxRenderable, title: string): void {
    const node = titles.get(header);
    if (node === undefined) throw new Error("Not a dialog header");
    node.content = title;
}

function retroHeaderHint(hint: string): string {
    if (hint.length === 0) return "";
    const label = hint.replace(/\s*·\s*esc$/, "");
    return label === "esc" ? "[Esc]" : `${label}  [Esc]`;
}

function brightenTitle(header: DialogHeaderRecord): void {
    const text = RGBA.fromHex(TUI_TEXT);
    const current = header.title.fg;
    if (header.suppliedTitle && (current.r !== text.r || current.g !== text.g || current.b !== text.b)) return;
    const panel = RGBA.fromHex(TUI_PANEL);
    const target = (panel.r + panel.g + panel.b) / 3 < 0.5 ? 1 : 0;
    header.title.fg = TUI_CHROME === "norton" ? TUI_NOTICE : RGBA.fromValues(
        text.r + (target - text.r) * 0.7,
        text.g + (target - text.g) * 0.7,
        text.b + (target - text.b) * 0.7,
        1,
    );
}

function applyHeaderChrome(header: DialogHeaderRecord): void {
    const boxed = styles.get(header.renderer) === "box";
    header.compact = header.renderer.height <= 10;
    const background = boxed ? mixHex(TUI_PANEL, TUI_TEXT, 0.10) : "transparent";
    header.box.minHeight = header.compact ? 1 : DIALOG_HEADER_HEIGHT;
    header.box.borderColor = mixHex(TUI_PANEL, TUI_TEXT, 0.30);
    // OpenTUI enables borders when assigning their color; choose sides last.
    header.box.border = boxed || header.compact ? false : ["bottom"];
    header.box.paddingTop = header.compact ? 0 : 1;
    header.box.paddingBottom = boxed && !header.compact ? 1 : 0;
    header.box.paddingLeft = boxed ? 1 : 0;
    header.box.paddingRight = boxed ? 1 : 0;
    header.box.backgroundColor = background;
    header.marker.visible = boxed;
    header.marker.fg = TUI_TEXT;
    header.marker.bg = background;
    brightenTitle(header);
    header.title.bg = background;
    header.hint.content = TUI_CHROME === "plain" ? header.plainHint : retroHeaderHint(header.plainHint);
    header.hint.fg = TUI_MUTED;
    header.hint.bg = background;
}

export function refreshDialogHeaders(): void {
    for (const header of headers) applyHeaderChrome(header);
}

export function dialogHeaderNode(
    renderer: RenderContext,
    title: string | TextRenderable,
    hint = "esc",
    trailing?: Renderable,
): BoxRenderable {
    const box = new BoxRenderable(renderer, {
        id: `dialog-header-${nextHeader++}`,
        width: "100%",
        height: "auto",
        minHeight: DIALOG_HEADER_HEIGHT,
        flexShrink: 0,
        flexDirection: "row",
        borderStyle: "single",
        onSizeChange() {
            if (record.compact !== (renderer.height <= 10)) applyHeaderChrome(record);
        },
        renderBefore() {
            brightenTitle(record);
        },
    });
    const titleNode = typeof title === "string" ? new TextRenderable(renderer, {
        content: title, attributes: 1, height: 1, wrapMode: "none", overflow: "hidden",
    }) : title;
    titleNode.width = "auto";
    titleNode.flexGrow = 1;
    titleNode.flexShrink = 1;
    titleNode.minWidth = 0;
    const marker = new TextRenderable(renderer, {
        id: `${box.id}-marker`,
        content: "❱ ", width: 2, height: 1, flexShrink: 0, selectable: false,
    });
    const hintNode = new TextRenderable(renderer, {
        id: `${box.id}-hint`,
        content: hint, height: 1, flexShrink: 0, marginLeft: hint.length > 0 ? 2 : 0,
        visible: trailing === undefined && hint.length > 0,
    });
    box.add(marker);
    box.add(titleNode);
    box.add(hintNode);
    if (trailing !== undefined) box.add(trailing);
    const record: DialogHeaderRecord = {
        compact: renderer.height <= 10,
        renderer, box, title: titleNode, marker, hint: hintNode, plainHint: hint,
        suppliedTitle: typeof title !== "string",
    };
    headers.add(record);
    titles.set(box, titleNode);
    box.once("destroyed", () => headers.delete(record));
    applyHeaderChrome(record);
    return box;
}
