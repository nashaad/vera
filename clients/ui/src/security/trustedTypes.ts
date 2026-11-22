export const ALLOWED_HTML_TAGS = new Set([
    "bdi", "br", "button", "code", "div", "path", "pre", "slot", "span", "style", "svg", "symbol", "use",
]);

export const ALLOWED_HTML_ATTRIBUTES = new Set([
    "aria-hidden", "class", "clip-rule", "d", "fill", "fill-rule", "focusable", "height", "href", "id",
    "name", "opacity", "preserveaspectratio", "role", "stroke", "stroke-linecap", "stroke-linejoin",
    "stroke-width", "style", "tabindex", "title", "transform", "type", "viewbox", "width", "xmlns",
]);

const DATA_ATTRIBUTE = /^data-[a-z0-9-]+$/;
const FORBIDDEN_TAGS = new Set(["script", "iframe", "object", "embed", "link", "meta", "base", "form"]);
const VOID_TAGS = new Set(["br"]);
const TAG_AT = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/y;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const STYLE_END = /<\/style\s*>/gi;

function checkAttribute(name: string, value: string): void {
    const attribute = name.toLowerCase();
    if (!DATA_ATTRIBUTE.test(attribute) && !ALLOWED_HTML_ATTRIBUTES.has(attribute)) {
        throw new TypeError(`Untrusted HTML attribute rejected: ${attribute}`);
    }
    if (attribute.startsWith("on")) throw new TypeError("Untrusted HTML event handler rejected");
    if (attribute === "href") {
        if (!value.trimStart().startsWith("#")) throw new TypeError("Untrusted HTML href rejected");
        return;
    }
    if (/^\s*(?:javascript|data):/i.test(value) || /(?:javascript|data):/i.test(value)) {
        throw new TypeError("Untrusted HTML URL rejected");
    }
}

function checkAttributes(body: string): boolean {
    ATTRIBUTE.lastIndex = 0;
    let attribute: RegExpExecArray | null;
    let consumed = 0;
    let selfClosing = false;
    while ((attribute = ATTRIBUTE.exec(body)) !== null) {
        consumed = attribute.index + attribute[0].length;
        const text = attribute[0].trim();
        if (text === "") continue;
        if (text === "/") {
            selfClosing = true;
            continue;
        }
        checkAttribute(attribute[1]!, attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    const remainder = body.slice(consumed).trim();
    if (remainder === "/") selfClosing = true;
    else if (remainder !== "") throw new TypeError("Untrusted HTML attribute syntax rejected");
    return selfClosing;
}

export function filterHtml(html: string): string {
    const stack: string[] = [];
    let cursor = 0;
    while (cursor < html.length) {
        const start = html.indexOf("<", cursor);
        if (start < 0) break;
        TAG_AT.lastIndex = start;
        const match = TAG_AT.exec(html);
        if (match === null) throw new TypeError("Untrusted HTML contains malformed markup");
        const tag = match[1]!.toLowerCase();
        if (FORBIDDEN_TAGS.has(tag) || !ALLOWED_HTML_TAGS.has(tag)) throw new TypeError(`Untrusted HTML tag rejected: ${tag}`);
        const closing = match[0].startsWith("</");
        const body = match[2] ?? "";
        if (closing) {
            if (body.trim() !== "") throw new TypeError("Untrusted HTML closing tag has attributes");
            if (stack.pop() !== tag) throw new TypeError("Untrusted HTML contains malformed markup");
            cursor = start + match[0].length;
            continue;
        }
        const selfClosing = checkAttributes(body);
        cursor = start + match[0].length;
        if (tag === "style") {
            STYLE_END.lastIndex = cursor;
            const end = STYLE_END.exec(html);
            if (end === null) throw new TypeError("Untrusted HTML contains malformed markup");
            cursor = end.index + end[0].length;
            continue;
        }
        if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(tag);
    }
    if (cursor < html.length && html.indexOf("<", cursor) >= 0) throw new TypeError("Untrusted HTML contains malformed markup");
    if (stack.length > 0) throw new TypeError("Untrusted HTML contains malformed markup");
    return html;
}

function workerUrl(): URL | undefined {
    if (typeof location === "undefined") return undefined;
    return new URL("./worker.js", location.href);
}

export function filterScriptUrl(value: string): string {
    const expected = workerUrl();
    if (expected === undefined) throw new TypeError("Worker URL unavailable");
    let parsed: URL;
    try {
        parsed = new URL(value, location.href);
    } catch {
        throw new TypeError("Untrusted script URL");
    }
    if (parsed.href !== expected.href) throw new TypeError("Untrusted script URL");
    return value;
}

interface TrustedTypesWindow extends Window {
    readonly trustedTypes?: {
        readonly defaultPolicy?: unknown;
        createPolicy(name: string, rules: { createHTML?: (html: string) => string; createScriptURL?: (url: string) => string }): unknown;
    };
}

export function installTrustedTypesPolicy(): void {
    const api = (globalThis as unknown as TrustedTypesWindow).trustedTypes;
    if (api === undefined) return;
    if (api.defaultPolicy !== undefined && api.defaultPolicy !== null) return;
    try {
        api.createPolicy("default", {
            createHTML: filterHtml,
            createScriptURL: filterScriptUrl,
        });
    } catch {
        // A default policy already exists in this renderer.
    }
}

installTrustedTypesPolicy();
