export interface CaptureRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface SelectionDetails {
    readonly tag: string;
    readonly selector: string;
    readonly text: string;
    readonly styles: string;
    readonly html: string;
    readonly siblings: string;
}

export interface AnnotationResult {
    readonly rect: CaptureRect;
    readonly text: string;
    readonly details?: SelectionDetails;
}

export const TEXT_LIMIT = 500;
export const HTML_LIMIT = 2000;
export const SIBLING_LIMIT = 10;
export const TAG_LIMIT = 256;
export const SELECTOR_LIMIT = 4096;
export const STYLES_LIMIT = 4096;
export const SIBLINGS_LIMIT = 4096;
export const TEXT_BLOCK_LIMIT = 16384;

export function clipText(value: string, limit: number): string {
    const collapsed = value.replace(/\s+/g, " ").trim();
    return truncate(collapsed, limit);
}

function truncate(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

export function uniqueSelector(element: Element): string {
    if (element === document.documentElement) return "html";
    const parts: string[] = [];
    let current: Element | null = element;
    while (current !== null && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        let part = current.localName;
        if (current.id) part += `#${CSS.escape(current.id)}`;
        parts.unshift(part);
        let candidate = parts.join(" > ");
        if (current.id) {
            const idSelector = `#${CSS.escape(current.id)}`;
            if (idSelector.length <= SELECTOR_LIMIT && document.querySelectorAll(idSelector).length === 1) return idSelector;
        }
        if (candidate.length <= SELECTOR_LIMIT && document.querySelectorAll(candidate).length === 1) return candidate;
        if (parent !== null) {
            let position = 1;
            let previous = current.previousElementSibling;
            while (previous !== null) {
                if (previous.localName === current.localName) position += 1;
                previous = previous.previousElementSibling;
            }
            parts[0] += `:nth-of-type(${position})`;
            candidate = parts.join(" > ");
            if (candidate.length <= SELECTOR_LIMIT && document.querySelectorAll(candidate).length === 1) return candidate;
        }
        current = parent;
    }
    const candidate = `html${parts.length > 0 ? ` > ${parts.join(" > ")}` : ""}`;
    if (candidate.length <= SELECTOR_LIMIT && document.querySelectorAll(candidate).length === 1) return candidate;
    throw new RangeError();
}

export function describeSelection(element: Element): SelectionDetails {
    const style = getComputedStyle(element);
    const names = [
        "display", "position", "width", "height", "margin", "padding", "color",
        "background-color", "font-size", "font-weight",
    ];
    const styles = names.map((name) => `${name} ${style.getPropertyValue(name)}`).concat([
        `border ${style.borderWidth} ${style.borderStyle}`,
        `border-radius ${style.borderRadius}`,
    ]);
    if (["flex", "inline-flex", "grid", "inline-grid"].includes(style.display)) {
        styles.push(
            `flex-direction ${style.flexDirection}`,
            `justify-content ${style.justifyContent}`,
            `align-items ${style.alignItems}`,
        );
    }
    const siblings: Element[] = [element];
    let previous = element.previousElementSibling;
    for (let index = 0; index < Math.floor((SIBLING_LIMIT - 1) / 2) && previous !== null; index += 1) {
        siblings.unshift(previous);
        previous = previous.previousElementSibling;
    }
    let next = element.nextElementSibling;
    while (siblings.length < SIBLING_LIMIT && next !== null) {
        siblings.push(next);
        next = next.nextElementSibling;
    }
    while (siblings.length < SIBLING_LIMIT && previous !== null) {
        siblings.unshift(previous);
        previous = previous.previousElementSibling;
    }
    const listed = siblings.map((sibling) => {
        let tag = `<${sibling.localName}`;
        let attrCount = 0;
        let cutAttributes = false;
        for (let index = 0; index < sibling.attributes.length && attrCount < 16; index += 1) {
            const attribute = sibling.attributes.item(index);
            if (attribute === null || attribute.name === "style") continue;
            const part = ` ${attribute.name.slice(0, 64)}="${attribute.value.slice(0, 128)}"`;
            if (tag.length + part.length + 1 > 370) {
                cutAttributes = true;
                break;
            }
            tag += part;
            attrCount += 1;
        }
        if (cutAttributes) tag += " …";
        tag += ">";
        return sibling === element ? `${tag} (selected)` : tag;
    });
    return {
        tag: truncate(element.localName, TAG_LIMIT),
        selector: uniqueSelector(element),
        text: clipText((element as HTMLElement).innerText ?? element.textContent ?? "", TEXT_LIMIT),
        styles: truncate(styles.join("; "), STYLES_LIMIT),
        html: truncate(element.outerHTML, HTML_LIMIT),
        siblings: truncate(listed.join(", "), SIBLINGS_LIMIT),
    };
}

export function canAddAnnotation(hasSelection: boolean, drawingCount: number): boolean {
    return hasSelection || drawingCount > 0;
}

export function clipRect(rect: CaptureRect, viewportWidth: number, viewportHeight: number): CaptureRect {
    const width = Math.max(0, Math.min(viewportWidth, 10000));
    const height = Math.max(0, Math.min(viewportHeight, 10000));
    const left = Math.max(0, Math.min(width, rect.x));
    const top = Math.max(0, Math.min(height, rect.y));
    const right = Math.max(left, Math.min(width, rect.x + Math.max(0, rect.width)));
    const bottom = Math.max(top, Math.min(height, rect.y + Math.max(0, rect.height)));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

export function buildTextBlock(pageUrl: string, details?: SelectionDetails): string {
    const boundedUrl = truncate(pageUrl, 1024);
    if (details === undefined) return truncate(`Selected in the Browser tab on ${boundedUrl}`, TEXT_BLOCK_LIMIT);
    return truncate([
        `Selected in the Browser tab on ${boundedUrl}`,
        `Element: ${details.tag}`,
        `Selector: ${details.selector}`,
        `Text: ${details.text}`,
        `Styles: ${details.styles}`,
        `HTML: ${details.html}`,
        `Siblings: ${details.siblings}`,
    ].join("\n"), TEXT_BLOCK_LIMIT);
}
