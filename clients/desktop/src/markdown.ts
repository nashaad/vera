import { Marked, Renderer } from "marked";

const renderer = new Renderer();

renderer.html = ({ text }) => escapeHtml(text);

renderer.link = function ({ href, title, tokens }): string {
    const content = this.parser.parseInline(tokens);
    const safeHref = normalizeLinkHref(href);
    if (safeHref === undefined) {
        return content;
    }

    const titleAttribute = title == null
        ? ""
        : ` title="${escapeHtml(title)}"`;
    return `<a href="${escapeHtml(safeHref)}"${titleAttribute} target="_blank" rel="noreferrer">${content}</a>`;
};

renderer.image = ({ text }): string => escapeHtml(`[image: ${text}]`);

const markdown = new Marked({
    gfm: true,
    renderer,
});

export function renderAssistantMarkdown(source: string): string {
    return markdown.parse(source, { async: false });
}

function normalizeLinkHref(href: string): string | undefined {
    try {
        const url = new URL(href);
        if (
            url.protocol === "https:"
            || url.protocol === "http:"
            || url.protocol === "mailto:"
        ) {
            return url.href;
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
