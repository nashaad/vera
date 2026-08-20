import {
    CodeRenderable,
    type MarkdownRenderable,
    type MouseEvent,
    TextTableRenderable,
    type TextChunk,
} from "@opentui/core";
import { Parser } from "htmlparser2";
import { Lexer } from "marked";

export type TuiLinkOpener = (url: string) => void | Promise<void>;

interface LinkTarget {
    readonly href: string;
    readonly label: string;
}

interface LinkRegion {
    readonly start: number;
    readonly end: number;
    readonly href: string;
}

interface LineInfo {
    readonly lineStartCols: readonly number[];
    readonly lineWidthCols: readonly number[];
}

interface TuiMarkdownRenderableForHitTesting {
    readonly content: string;
    readonly plainText: string;
    readonly lineInfo: LineInfo;
    readonly screenX: number;
    readonly screenY: number;
    readonly scrollX: number;
    readonly scrollY: number;
}

interface TableLayout {
    readonly columnOffsets: readonly number[];
    readonly columnWidths: readonly number[];
    readonly rowOffsets: readonly number[];
    readonly rowHeights: readonly number[];
}

interface TableCell {
    readonly textBufferView: {
        readonly lineInfo: LineInfo;
    };
}

interface TuiMarkdownTableForHitTesting {
    readonly content: readonly (readonly (readonly TextChunk[] | null | undefined)[])[];
    readonly _cells: readonly (readonly TableCell[])[];
    readonly _layout: TableLayout;
    readonly _cellPaddingX: number;
    readonly _cellPaddingY: number;
    readonly screenX: number;
    readonly screenY: number;
}

interface TuiMousePosition {
    readonly x: number;
    readonly y: number;
}

export function isSupportedTuiLink(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            return true;
        }
        if (parsed.protocol === "obsidian:") {
            return parsed.hostname === "open";
        }
        return parsed.protocol === "file:"
            && (parsed.hostname === "" || parsed.hostname === "localhost")
            && parsed.pathname.length > 0;
    } catch {
        return false;
    }
}

export function activateTuiLink(
    url: string,
    openLink: TuiLinkOpener,
): boolean {
    if (!isSupportedTuiLink(url)) return false;

    try {
        const result = openLink(url);
        if (result !== undefined) {
            void Promise.resolve(result).catch(() => undefined);
        }
    } catch {
        // A missing platform opener must not interrupt transcript interaction.
    }
    return true;
}

export function openTuiLink(url: string): void {
    if (!isSupportedTuiLink(url)) return;

    const command = process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
            ? ["explorer.exe", url]
            : ["xdg-open", url];

    try {
        Bun.spawn(command, {
            detached: true,
            stdout: "ignore",
            stderr: "ignore",
        });
    } catch {
        // The transcript remains usable when the host has no platform opener.
    }
}

export function installTuiMarkdownLinkHandlers(
    markdown: MarkdownRenderable,
    openLink: TuiLinkOpener,
): void {
    for (const child of markdownDescendants(markdown)) {
        if (child instanceof CodeRenderable) {
            child.onMouseUp = (event: MouseEvent) => {
                if (event.button !== 0 || child.hasSelection()) return;

                activateMouseLink(tuiMarkdownLinkAtMouse(child, event), event, openLink);
            };
            continue;
        }

        child.onMouseUp = (event: MouseEvent) => {
            if (event.button !== 0 || child.hasSelection()) return;

            activateMouseLink(tuiMarkdownTableLinkAtMouse(child, event), event, openLink);
        };
    }
}

function activateMouseLink(
    href: string | undefined,
    event: MouseEvent,
    openLink: TuiLinkOpener,
): void {
    if (href === undefined) return;

    event.preventDefault();
    event.stopPropagation();
    activateTuiLink(href, openLink);
}

export function tuiMarkdownLinkAtMouse(
    renderable: TuiMarkdownRenderableForHitTesting,
    event: TuiMousePosition,
): string | undefined {
    const row = event.y - renderable.screenY + renderable.scrollY;
    const column = event.x - renderable.screenX + renderable.scrollX;
    const line = Math.floor(row);
    const info = renderable.lineInfo;
    const lineStart = info.lineStartCols[line];
    const lineWidth = info.lineWidthCols[line];

    if (lineStart === undefined || lineWidth === undefined) return undefined;
    if (column < 0 || column >= lineWidth) return undefined;

    const displayOffset = lineStart + column;
    return linkRegions(renderable.content, renderable.plainText).find((region) => {
        const start = displayWidth(renderable.plainText.slice(0, region.start));
        const end = displayWidth(renderable.plainText.slice(0, region.end));
        return displayOffset >= start && displayOffset < end;
    })?.href;
}

function tuiMarkdownTableLinkAtMouse(
    table: TextTableRenderable,
    event: TuiMousePosition,
): string | undefined {
    // OpenTUI exposes table link chunks but keeps their cell geometry private;
    // mirror that geometry here so clicks stay in the client-owned renderer.
    const internal = table as unknown as TuiMarkdownTableForHitTesting;
    const localX = event.x - internal.screenX;
    const localY = event.y - internal.screenY;
    const { _layout: layout } = internal;
    const row = tableCoordinateIndex(
        layout.rowOffsets,
        layout.rowHeights,
        localY,
    );
    const column = tableCoordinateIndex(
        layout.columnOffsets,
        layout.columnWidths,
        localX,
    );

    if (row === undefined || column === undefined) return undefined;

    const cell = internal._cells[row]?.[column];
    const chunks = internal.content[row]?.[column];
    if (cell === undefined || chunks === undefined || chunks === null) {
        return undefined;
    }

    const cellX = localX
        - (layout.columnOffsets[column]! + 1 + internal._cellPaddingX);
    const cellY = localY
        - (layout.rowOffsets[row]! + 1 + internal._cellPaddingY);
    const line = Math.floor(cellY);
    const lineStart = cell.textBufferView.lineInfo.lineStartCols[line];
    const lineWidth = cell.textBufferView.lineInfo.lineWidthCols[line];
    if (lineStart === undefined || lineWidth === undefined) return undefined;
    if (cellX < 0 || cellX >= lineWidth) return undefined;

    const displayOffset = lineStart + cellX;
    let chunkStart = 0;
    for (const chunk of chunks) {
        const chunkEnd = chunkStart + displayWidth(chunk.text);
        if (
            chunk.link !== undefined
            && displayOffset >= chunkStart
            && displayOffset < chunkEnd
        ) {
            return chunk.link.url;
        }
        chunkStart = chunkEnd;
    }
    return undefined;
}

function tableCoordinateIndex(
    offsets: readonly number[],
    sizes: readonly number[],
    coordinate: number,
): number | undefined {
    for (let index = 0; index < sizes.length; index += 1) {
        const start = offsets[index]! + 1;
        const end = start + sizes[index]! - 1;
        if (coordinate >= start && coordinate <= end) return index;
    }
    return undefined;
}

function markdownDescendants(
    markdown: MarkdownRenderable,
): Array<CodeRenderable | TextTableRenderable> {
    const result: Array<CodeRenderable | TextTableRenderable> = [];
    const visit = (node: { getChildren(): unknown[] }): void => {
        for (const child of node.getChildren()) {
            if (child instanceof CodeRenderable || child instanceof TextTableRenderable) {
                result.push(child);
            }
            if (isRenderableWithChildren(child)) visit(child);
        }
    };
    visit(markdown);
    return result;
}

function isRenderableWithChildren(
    value: unknown,
): value is { getChildren(): unknown[] } {
    return typeof value === "object"
        && value !== null
        && "getChildren" in value
        && typeof value.getChildren === "function";
}

function linkRegions(content: string, renderedText: string): LinkRegion[] {
    const targets: LinkTarget[] = [];
    collectLinkTargets(Lexer.lex(content), targets);

    const regions: LinkRegion[] = [];
    let searchFrom = 0;
    for (const target of targets) {
        const hrefIndex = renderedText.indexOf(target.href, searchFrom);
        if (hrefIndex === -1) continue;

        const labelIndex = renderedText.lastIndexOf(target.label, hrefIndex);
        const start = labelIndex >= searchFrom ? labelIndex : hrefIndex;
        regions.push({
            start,
            end: hrefIndex + target.href.length,
            href: target.href,
        });
        searchFrom = hrefIndex + target.href.length;
    }
    return regions;
}

function collectLinkTargets(tokens: readonly unknown[], targets: LinkTarget[]): void {
    for (const token of tokens) {
        if (!isObject(token)) continue;

        if (typeof token.href === "string") {
            targets.push({
                href: token.href,
                label: visibleInlineText(token.tokens, token.text),
            });
        }

        for (const value of Object.values(token)) {
            if (Array.isArray(value)) collectLinkTargets(value, targets);
        }
    }
}

function visibleInlineText(tokens: unknown, fallback: unknown): string {
    if (Array.isArray(tokens)) {
        return tokens.map((token) => visibleInlineToken(token)).join("");
    }
    return typeof fallback === "string" ? decodeMarkdownEntities(fallback) : "";
}

function visibleInlineToken(value: unknown): string {
    if (!isObject(value)) return "";
    if (value.type === "br") return "\n";
    if (Array.isArray(value.tokens)) {
        return value.tokens.map((token) => visibleInlineToken(token)).join("");
    }
    if (typeof value.text === "string") return decodeMarkdownEntities(value.text);
    return "";
}

function decodeMarkdownEntities(value: string): string {
    let decoded = "";
    const parser = new Parser(
        { ontext: (text) => { decoded += text; } },
        { decodeEntities: true },
    );
    parser.end(value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    return decoded;
}

function displayWidth(value: string): number {
    let width = 0;
    for (const character of value) {
        width += character === "\n" ? 1 : Bun.stringWidth(character);
    }
    return width;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
