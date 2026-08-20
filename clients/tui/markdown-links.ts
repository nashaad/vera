import {
    CodeRenderable,
    type MarkdownRenderable,
    type MouseEvent,
} from "@opentui/core";
import { Lexer } from "marked";

export type TuiLinkOpener = (url: string) => void | Promise<void>;

interface LinkTarget {
    readonly href: string;
    readonly text: string;
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
        if (!(child instanceof CodeRenderable)) continue;

        child.onMouseUp = (event: MouseEvent) => {
            if (event.button !== 0 || child.hasSelection()) return;

            const href = tuiMarkdownLinkAtMouse(child, event);
            if (href === undefined) return;

            event.preventDefault();
            event.stopPropagation();
            activateTuiLink(href, openLink);
        };
    }
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

    const offset = lineStart + column;
    return linkRegions(renderable.content, renderable.plainText).find(
        (region) => offset >= region.start && offset < region.end,
    )?.href;
}

function markdownDescendants(markdown: MarkdownRenderable): CodeRenderable[] {
    const result: CodeRenderable[] = [];
    const visit = (node: { getChildren(): unknown[] }): void => {
        for (const child of node.getChildren()) {
            if (child instanceof CodeRenderable) result.push(child);
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

        const labelIndex = renderedText.lastIndexOf(target.text, hrefIndex);
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
                text: typeof token.text === "string" ? token.text : token.href,
            });
        }

        for (const value of Object.values(token)) {
            if (Array.isArray(value)) collectLinkTargets(value, targets);
        }
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
