import type { ReactNode } from "react";
import type { Token, Tokens } from "marked";

import { PageLink } from "../pagepane/PageLinks.tsx";
import { splitAddresses } from "../pagepane/links.ts";

interface InlineOptions {
    readonly fade: boolean;
    readonly links: boolean;
}

function words(text: string, key: string): ReactNode[] {
    let index = 0;
    return text.split(/(\s+)/).map((part) => {
        if (part === "" || /^\s+$/.test(part)) return part;
        return <span key={`${key}-w${index++}`} className="word-in">{part}</span>;
    });
}

function plain(text: string, key: string, options: InlineOptions): ReactNode {
    return options.fade ? words(text, key) : text;
}

function textNodes(text: string, key: string, options: InlineOptions): ReactNode[] {
    if (!options.links) return [plain(text, key, options)];
    return splitAddresses(text).map((part, index) => {
        const partKey = `${key}-${index}`;
        if (part.kind === "text") return plain(part.text, partKey, options);
        return <PageLink key={partKey} href={part.url} bare>{plain(part.url, partKey, options)}</PageLink>;
    });
}

function linkNode(token: Tokens.Link, key: string, options: InlineOptions): ReactNode {
    const inner = inlineTokens(token.tokens, key, { fade: false, links: false });
    if (!options.links) return inner;
    const bare = token.raw === token.text && /^https?:\/\//.test(token.raw);
    if (bare) {
        const parts = splitAddresses(token.raw);
        if (parts[0]?.kind === "url") {
            const url = parts[0].url;
            return [
                <PageLink key={`${key}-link`} href={url} bare>{url}</PageLink>,
                ...parts.slice(1).map((part, index) => part.kind === "text" ? plain(part.text, `${key}-${index}`, options) : part.url),
            ];
        }
    }
    return <PageLink key={key} href={token.href}>{inner}</PageLink>;
}

export function inlineTokens(tokens: readonly Token[], key: string, options: InlineOptions): ReactNode[] {
    return tokens.map((token, index) => {
        const tokenKey = `${key}-${index}`;
        switch (token.type) {
            case "text":
                return token.tokens === undefined
                    ? textNodes(token.text, tokenKey, options)
                    : inlineTokens(token.tokens, tokenKey, options);
            case "escape":
            case "html":
                return plain(token.text, tokenKey, options);
            case "strong":
                return <strong key={tokenKey}>{inlineTokens(token.tokens ?? [], tokenKey, { ...options, fade: false })}</strong>;
            case "em":
                return <em key={tokenKey}>{inlineTokens(token.tokens ?? [], tokenKey, { ...options, fade: false })}</em>;
            case "del":
                return <del key={tokenKey}>{inlineTokens(token.tokens ?? [], tokenKey, { ...options, fade: false })}</del>;
            case "codespan":
                return <code key={tokenKey}>{token.text}</code>;
            case "br":
                return <br key={tokenKey} />;
            case "checkbox":
                return <input key={tokenKey} className="markdown-task-checkbox" type="checkbox" checked={token.checked} disabled readOnly />;
            case "link":
                return linkNode(token as Tokens.Link, tokenKey, options);
            case "image": {
                const label = inlineTokens(token.tokens ?? [], tokenKey, { fade: false, links: false });
                if (!options.links) return label;
                return <a key={tokenKey} role="link" aria-disabled="true" title={token.href}>{label}</a>;
            }
            default:
                return plain(token.raw, tokenKey, options);
        }
    });
}
