import type { ReactNode } from "react";
import type { Token, Tokens } from "marked";

import { CodeCard } from "./CodeCard.tsx";
import { inlineTokens } from "./MarkdownInline.tsx";

export function isClosedFence(block: string): boolean {
    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(block);
    if (opening === null) return false;
    const fence = opening[1]!;
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`, "m");
    return closing.test(block.slice(opening[0].length));
}

function codeCard(token: Tokens.Code, key: string, fade: boolean): ReactNode {
    const fenced = token.codeBlockStyle !== "indented";
    const closed = fenced && isClosedFence(token.raw);
    let body = token.text;
    const openingEnd = token.raw.indexOf("\n");
    if (fenced && !closed && openingEnd >= 0 && openingEnd < token.raw.length - 1 && token.raw.endsWith("\n")) body += "\n";
    return <CodeCard key={key} lang={(token.lang ?? "").trim()} body={body} ready={!fenced || closed || !fade} />;
}

function list(token: Tokens.List, key: string, fade: boolean): ReactNode {
    const items = token.items.map((item, index) => (
        <li key={index} className={item.task ? "markdown-task-item" : undefined}>
            {renderBlocks(item.tokens, `${key}-${index}`, fade)}
        </li>
    ));
    return token.ordered
        ? <ol key={key} start={typeof token.start === "number" ? token.start : undefined}>{items}</ol>
        : <ul key={key}>{items}</ul>;
}

function table(token: Tokens.Table, key: string, fade: boolean): ReactNode {
    const options = { fade, links: true };
    return (
        <div key={key} className="markdown-table-scroll">
            <table>
                <thead><tr>{token.header.map((cell, index) => (
                    <th key={index} style={cell.align === null ? undefined : { textAlign: cell.align }}>
                        {inlineTokens(cell.tokens, `${key}-h${index}`, options)}
                    </th>
                ))}</tr></thead>
                {token.rows.length === 0 ? null : <tbody>{token.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>{row.map((cell, cellIndex) => (
                        <td key={cellIndex} style={cell.align === null ? undefined : { textAlign: cell.align }}>
                            {inlineTokens(cell.tokens, `${key}-r${rowIndex}-${cellIndex}`, options)}
                        </td>
                    ))}</tr>
                ))}</tbody>}
            </table>
        </div>
    );
}

export function renderBlock(token: Token, key: string, fade: boolean): ReactNode {
    const options = { fade, links: true };
    switch (token.type) {
        case "heading": {
            const level = Math.min(token.depth + 2, 6);
            const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
            return <Tag key={key}>{inlineTokens(token.tokens ?? [], key, options)}</Tag>;
        }
        case "paragraph":
            return <p key={key}>{inlineTokens(token.tokens ?? [], key, options)}</p>;
        case "text":
            return inlineTokens([token], key, options);
        case "checkbox":
            return inlineTokens([token], key, options);
        case "code":
            return codeCard(token as Tokens.Code, key, fade);
        case "list":
            return list(token as Tokens.List, key, fade);
        case "blockquote":
            return <blockquote key={key}>{renderBlocks(token.tokens ?? [], key, fade)}</blockquote>;
        case "hr":
            return <hr key={key} />;
        case "table":
            return table(token as Tokens.Table, key, fade);
        case "html":
            return <p key={key} className="markdown-html">{inlineTokens([token], key, options)}</p>;
        default:
            return <p key={key}>{token.raw}</p>;
    }
}

export function renderBlocks(tokens: readonly Token[], key: string, fade: boolean): ReactNode[] {
    return tokens.filter((token) => token.type !== "space" && token.type !== "def")
        .map((token, index) => renderBlock(token, `${key}-${index}`, fade));
}
