import { Parser } from "htmlparser2";

export interface HtmlMarkdown {
    readonly title: string;
    readonly markdown: string;
}

interface ListState {
    kind: "ul" | "ol";
    next: number;
}

interface TableState {
    rows: string[][];
    row: string[];
}

interface LinkInline {
    kind: "a";
    href: string;
    text: string;
}

interface StrongInline {
    kind: "strong";
    text: string;
}

interface EmInline {
    kind: "em";
    text: string;
}

interface CodeInline {
    kind: "code";
    text: string;
}

interface CellInline {
    kind: "cell";
    text: string;
}

type Inline = LinkInline | StrongInline | EmInline | CodeInline | CellInline;

const SKIPPED = new Set([
    "head",
    "script",
    "style",
    "noscript",
    "iframe",
    "object",
    "embed",
    "svg",
    "canvas",
    "template",
]);

/**
 * Turns an HTML page into markdown so a later character budget applies to the
 * readable document, not the tags and scripts that made the response large.
 * Relative links resolve against `baseUrl`. Inline `data:` images are dropped
 * because they spend the whole output budget on one asset.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): HtmlMarkdown {
    let title = "";
    let out = "";
    let skipDepth = 0;
    let titleDepth = 0;
    let quoteDepth = 0;
    let preDepth = 0;
    let preBuf = "";
    let preLang = "";
    const lists: ListState[] = [];
    const tables: TableState[] = [];
    const inlines: Inline[] = [];

    const parser = new Parser({
        onopentag(name, attribs) {
            if (name === "title") titleDepth += 1;
            if (skipDepth > 0 || SKIPPED.has(name)) {
                skipDepth += 1;
                return;
            }
            if (preDepth > 0) {
                if (name === "code") {
                    preLang = languageClass(attribs.class) ?? preLang;
                }
                return;
            }
            openTag(name, attribs);
        },
        ontext(value) {
            if (titleDepth > 0) title += value;
            if (skipDepth > 0) return;
            if (preDepth > 0) {
                preBuf += value;
                return;
            }
            emitText(collapseSpace(value));
        },
        onclosetag(name) {
            if (name === "title" && titleDepth > 0) titleDepth -= 1;
            if (skipDepth > 0) {
                skipDepth -= 1;
                return;
            }
            if (preDepth > 0 && name !== "pre") return;
            closeTag(name);
        },
    }, { decodeEntities: true });
    parser.end(html);

    return {
        title: collapseSpace(title).trim(),
        markdown: normalizeMarkdown(out),
    };

    function openTag(name: string, attribs: Record<string, string>): void {
        switch (name) {
            case "h1":
            case "h2":
            case "h3":
            case "h4":
            case "h5":
            case "h6":
                ensureBlankLine();
                emitText(`${"#".repeat(Number(name[1]))} `);
                return;
            case "p":
                if (lists.length === 0) ensureBlankLine();
                return;
            case "br":
                ensureNewline();
                return;
            case "hr":
                ensureBlankLine();
                emitRaw("---");
                ensureBlankLine();
                return;
            case "blockquote":
                quoteDepth += 1;
                ensureBlankLine();
                return;
            case "ul":
            case "ol":
                lists.push({ kind: name, next: 1 });
                return;
            case "li":
                openListItem();
                return;
            case "pre":
                preDepth += 1;
                preBuf = "";
                preLang = "";
                return;
            case "code":
                if (inlines.some((item) => item.kind === "code")) return;
                inlines.push({ kind: "code", text: "" });
                return;
            case "strong":
            case "b":
                inlines.push({ kind: "strong", text: "" });
                return;
            case "em":
            case "i":
                inlines.push({ kind: "em", text: "" });
                return;
            case "a":
                inlines.push({ kind: "a", href: attribs.href ?? "", text: "" });
                return;
            case "img":
                emitImage(attribs);
                return;
            case "table":
                tables.push({ rows: [], row: [] });
                return;
            case "tr":
                if (tables.length > 0) tables[tables.length - 1]!.row = [];
                return;
            case "th":
            case "td":
                inlines.push({ kind: "cell", text: "" });
                return;
            case "article":
            case "section":
            case "main":
            case "div":
            case "figure":
            case "figcaption":
                ensureNewline();
                return;
        }
    }

    function closeTag(name: string): void {
        switch (name) {
            case "h1":
            case "h2":
            case "h3":
            case "h4":
            case "h5":
            case "h6":
            case "p":
                ensureBlankLine();
                return;
            case "blockquote":
                if (quoteDepth > 0) quoteDepth -= 1;
                ensureBlankLine();
                return;
            case "ul":
            case "ol":
                lists.pop();
                ensureBlankLine();
                return;
            case "li":
                ensureNewline();
                return;
            case "pre":
                closePre();
                return;
            case "code":
                closeInline("code", wrapInlineCode);
                return;
            case "strong":
            case "b":
                closeInline("strong", (text) => wrapMarks(text, "**"));
                return;
            case "em":
            case "i":
                closeInline("em", (text) => wrapMarks(text, "*"));
                return;
            case "a":
                closeLink();
                return;
            case "tr":
                closeTableRow();
                return;
            case "th":
            case "td":
                closeCell();
                return;
            case "table":
                closeTable();
                return;
            case "article":
            case "section":
            case "main":
            case "div":
            case "figure":
            case "figcaption":
                ensureNewline();
                return;
        }
    }

    function openListItem(): void {
        const list = lists[lists.length - 1];
        ensureNewline();
        const indent = "  ".repeat(Math.max(0, lists.length - 1));
        const marker = list === undefined
            ? "-"
            : list.kind === "ul"
            ? "-"
            : `${list.next}.`;
        if (list !== undefined) list.next += 1;
        emitRaw(`${indent}${marker} `);
    }

    function closePre(): void {
        if (preDepth === 0) return;
        preDepth -= 1;
        ensureBlankLine();
        const body = preBuf.replace(/\n$/, "");
        emitRaw("```" + preLang + "\n" + body + "\n```");
        ensureBlankLine();
        preBuf = "";
        preLang = "";
    }

    function closeInline(
        kind: Inline["kind"],
        wrap: (text: string) => string,
    ): void {
        const item = popInline(kind);
        if (item === undefined) return;
        emitText(wrap(item.text));
    }

    function closeLink(): void {
        const item = popInline("a");
        if (item === undefined || item.kind !== "a") return;
        const text = item.text.trim();
        const href = item.href.trim();
        if (text.length === 0) return;
        if (!isSafeHref(href)) {
            emitText(item.text);
            return;
        }
        emitText(`[${text}](${resolveUrl(href, baseUrl)})`);
    }

    function emitImage(attribs: Record<string, string>): void {
        const src = attribs.src?.trim() ?? "";
        const alt = attribs.alt ?? "";
        if (src.length === 0 || src.startsWith("data:")) {
            if (alt.length > 0) emitText(alt);
            return;
        }
        if (!isSafeHref(src)) {
            if (alt.length > 0) emitText(alt);
            return;
        }
        emitText(`![${alt}](${resolveUrl(src, baseUrl)})`);
    }

    function closeCell(): void {
        const item = popInline("cell");
        const table = tables[tables.length - 1];
        if (item === undefined || table === undefined) return;
        table.row.push(item.text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim());
    }

    function closeTableRow(): void {
        const table = tables[tables.length - 1];
        if (table === undefined || table.row.length === 0) return;
        table.rows.push(table.row);
        table.row = [];
    }

    function closeTable(): void {
        const table = tables.pop();
        if (table === undefined) return;
        if (table.row.length > 0) table.rows.push(table.row);
        const markdown = formatTable(table.rows);
        if (markdown.length === 0) return;
        ensureBlankLine();
        emitRaw(markdown);
        ensureBlankLine();
    }

    function popInline(kind: Inline["kind"]): Inline | undefined {
        for (let index = inlines.length - 1; index >= 0; index -= 1) {
            if (inlines[index]!.kind === kind) {
                const [item] = inlines.splice(index, 1);
                return item;
            }
        }
        return undefined;
    }

    function emitText(text: string): void {
        if (text.length === 0) return;
        const current = inlines[inlines.length - 1];
        if (current !== undefined) {
            current.text += text;
            return;
        }
        let next = text;
        const atLineStart = out.length === 0 || out.endsWith("\n");
        if (atLineStart || out.endsWith(" ")) {
            next = next.replace(/^ +/, "");
        }
        emitRaw(next);
    }

    function emitRaw(text: string): void {
        if (text.length === 0) return;
        const parts = text.split("\n");
        for (let index = 0; index < parts.length; index += 1) {
            if (index > 0) out += "\n";
            const part = parts[index]!;
            if (part.length === 0) continue;
            if (out.endsWith("\n") || out.length === 0) {
                out += quotePrefix() + part;
            } else {
                out += part;
            }
        }
    }

    function quotePrefix(): string {
        return quoteDepth > 0 ? "> ".repeat(quoteDepth) : "";
    }

    function ensureNewline(): void {
        if (out.length === 0 || out.endsWith("\n")) return;
        out += "\n";
    }

    function ensureBlankLine(): void {
        if (out.length === 0) return;
        ensureNewline();
        if (!out.endsWith("\n\n")) out += "\n";
    }
}

function collapseSpace(value: string): string {
    return value.replace(/\s+/g, " ");
}

function wrapMarks(text: string, marks: string): string {
    const inner = text.trim();
    if (inner.length === 0) return text;
    const leading = text.match(/^\s*/)?.[0] ?? "";
    const trailing = text.match(/\s*$/)?.[0] ?? "";
    return `${leading}${marks}${inner}${marks}${trailing}`;
}

function wrapInlineCode(text: string): string {
    const inner = text.trim();
    if (inner.length === 0) return text;
    const ticks = inner.includes("`") ? "``" : "`";
    const pad = inner.startsWith("`") || inner.endsWith("`") ? " " : "";
    const leading = text.match(/^\s*/)?.[0] ?? "";
    const trailing = text.match(/\s*$/)?.[0] ?? "";
    return `${leading}${ticks}${pad}${inner}${pad}${ticks}${trailing}`;
}

function languageClass(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const match = value.match(/(?:^|\s)language-([a-zA-Z0-9_+-]+)/);
    return match?.[1];
}

function isSafeHref(href: string): boolean {
    const trimmed = href.trim();
    if (trimmed.length === 0) return false;
    const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1]
        ?.toLowerCase();
    if (scheme === undefined) return true;
    return scheme === "http" || scheme === "https" || scheme === "mailto";
}

function resolveUrl(href: string, baseUrl?: string): string {
    try {
        return new URL(href, baseUrl).href;
    } catch {
        return href;
    }
}

function formatTable(rows: readonly (readonly string[])[]): string {
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((row) => row.length));
    if (width === 0) return "";
    const padded = rows.map((row) => {
        const cells = [...row];
        while (cells.length < width) cells.push("");
        return cells;
    });
    const header = padded[0]!;
    const separator = header.map(() => "---");
    const line = (cells: readonly string[]): string =>
        `| ${cells.join(" | ")} |`;
    return [line(header), line(separator), ...padded.slice(1).map(line)]
        .join("\n");
}

function normalizeMarkdown(value: string): string {
    return value
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
