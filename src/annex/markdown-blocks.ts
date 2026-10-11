import { Marked, type Token, type Tokens } from "marked";

import type { VeraMarkdownBlock } from "../sdk/annex-pages.ts";

const SAFE_LINK = /^(https?:|mailto:|#|\/(?!\/))/i;
const AUDIO = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"]);
const VIDEO = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);

const marked = new Marked({
    gfm: true,
    renderer: {
        html({ text }: Tokens.HTML | Tokens.Tag): string {
            return escapeHtml(text);
        },
        link({ href, title, tokens }: Tokens.Link): string {
            const label = this.parser.parseInline(tokens);
            if (!SAFE_LINK.test(href.trim())) return label;
            const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
            return `<a href="${escapeHtml(href)}"${titleAttribute} rel="noreferrer">${label}</a>`;
        },
        image({ href, text }: Tokens.Image): string {
            return mediaHtml(href, text) ?? escapeHtml(text);
        },
    },
});

export function markdownBlocks(markdown: string): readonly VeraMarkdownBlock[] {
    const blocks: VeraMarkdownBlock[] = [];
    for (const token of marked.lexer(markdown)) {
        if (token.type === "space" || token.type === "def") continue;
        if (token.type === "list") {
            blocks.push(...listItemBlocks(token as Tokens.List));
            continue;
        }
        blocks.push({
            kind: token.type,
            text: token.raw.trim(),
            html: marked.parser([token]),
        });
    }
    return blocks;
}

function listItemBlocks(list: Tokens.List): readonly VeraMarkdownBlock[] {
    const start = typeof list.start === "number" ? list.start : 1;
    return list.items.map((item, index) => {
        const single: Tokens.List = {
            ...list,
            items: [item],
            raw: item.raw,
            start: list.ordered ? start + index : "",
        };
        return {
            kind: "list_item",
            text: item.raw.trim(),
            html: marked.parser([single as Token]),
        };
    });
}

// Only https sources render; anything else stays as its alt text.
function mediaHtml(href: string, alt: string): string | undefined {
    let url: URL;
    try {
        url = new URL(href.trim());
    } catch {
        return undefined;
    }
    if (url.protocol !== "https:") return undefined;
    const src = escapeHtml(url.href);
    const label = escapeHtml(alt);
    const extension = url.pathname.slice(url.pathname.lastIndexOf(".") + 1).toLowerCase();
    if (AUDIO.has(extension)) return `<audio controls preload="metadata" src="${src}" aria-label="${label}"></audio>`;
    if (VIDEO.has(extension)) return `<video controls preload="metadata" src="${src}" aria-label="${label}"></video>`;
    return `<img src="${src}" alt="${label}" loading="lazy" referrerpolicy="no-referrer">`;
}

function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}
