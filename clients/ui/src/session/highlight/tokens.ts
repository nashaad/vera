// Index 0 is unstyled text; the others name the `tok-*` class a token gets.
export const KIND_NAMES = [
    "plain",
    "comment",
    "keyword",
    "string",
    "number",
    "function",
    "type",
    "property",
    "tag",
    "added",
    "removed",
] as const;

export type TokenKind = (typeof KIND_NAMES)[number];

export const PLAIN = 0;

// Runs of text with one kind each, in two arrays so a long block is not one object per token.
export interface HighlightedCode {
    readonly texts: readonly string[];
    readonly kinds: Uint8Array;
}

function kindIndex(kind: TokenKind): number {
    return KIND_NAMES.indexOf(kind);
}

// Modifier classes (`function_` in "hljs-title function_") decide before the base class does.
const MODIFIERS: Readonly<Record<string, TokenKind>> = {
    function_: "function",
    invoke__: "function",
    class_: "type",
    keyword_: "keyword",
    string_: "string",
    language_: "keyword",
    constant_: "number",
    escape_: "string",
};

const BASES: Readonly<Record<string, TokenKind>> = {
    "hljs-comment": "comment",
    "hljs-doctag": "comment",
    "hljs-quote": "comment",
    "hljs-keyword": "keyword",
    "hljs-meta": "keyword",
    "hljs-selector-pseudo": "keyword",
    "hljs-template-tag": "keyword",
    "hljs-string": "string",
    "hljs-regexp": "string",
    "hljs-code": "string",
    "hljs-link": "string",
    "hljs-number": "number",
    "hljs-literal": "number",
    "hljs-symbol": "number",
    "hljs-bullet": "number",
    "hljs-title": "function",
    "hljs-section": "function",
    "hljs-type": "type",
    "hljs-class": "type",
    "hljs-built_in": "type",
    "hljs-selector-id": "type",
    "hljs-selector-class": "type",
    "hljs-attr": "property",
    "hljs-attribute": "property",
    "hljs-property": "property",
    "hljs-selector-attr": "property",
    "hljs-tag": "tag",
    "hljs-name": "tag",
    "hljs-selector-tag": "tag",
    "hljs-addition": "added",
    "hljs-deletion": "removed",
    // Interpolations and parameter lists start over as plain text inside a string or function.
    "hljs-subst": "plain",
    "hljs-params": "plain",
};

// Returns undefined for classes with no mapping, so the span keeps its parent's kind.
function kindOfClasses(classes: readonly string[]): number | undefined {
    for (const name of classes) {
        const modified = MODIFIERS[name];
        if (modified !== undefined) return kindIndex(modified);
    }
    for (const name of classes) {
        const base = BASES[name];
        if (base !== undefined) return kindIndex(base);
    }
    return undefined;
}

const ENTITIES: Readonly<Record<string, string>> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#x27;": "'",
};

function decode(text: string): string {
    return text.includes("&") ? text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? entity) : text;
}

const CLASS_ATTRIBUTE = /class="([^"]*)"/;

// Reads the span markup the highlighter emits into flat runs. Each run's kind comes from the innermost mapped span around it.
export function parseHighlighted(html: string): HighlightedCode {
    const texts: string[] = [];
    const kinds: number[] = [];
    const stack: number[] = [PLAIN];
    const add = (text: string): void => {
        if (text === "") return;
        const kind = stack[stack.length - 1] ?? PLAIN;
        const last = texts.length - 1;
        if (last >= 0 && kinds[last] === kind) texts[last] = `${texts[last] ?? ""}${text}`;
        else {
            texts.push(text);
            kinds.push(kind);
        }
    };
    let position = 0;
    while (position < html.length) {
        const open = html.indexOf("<", position);
        const close = open === -1 ? -1 : html.indexOf(">", open);
        if (open === -1 || close === -1) {
            add(decode(html.slice(position)));
            break;
        }
        if (open > position) add(decode(html.slice(position, open)));
        const tag = html.slice(open + 1, close);
        if (tag.startsWith("/")) {
            if (stack.length > 1) stack.pop();
        } else {
            const classes = CLASS_ATTRIBUTE.exec(tag)?.[1]?.split(" ") ?? [];
            stack.push(kindOfClasses(classes) ?? stack[stack.length - 1] ?? PLAIN);
        }
        position = close + 1;
    }
    return { texts, kinds: Uint8Array.from(kinds) };
}
