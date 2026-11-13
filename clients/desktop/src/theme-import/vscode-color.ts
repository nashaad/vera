const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Reads #rgb, #rgba, #rrggbb and #rrggbbaa and writes #rrggbb or #rrggbbaa in lower case.
// Anything else, including color names and VS Code's "default", is not a color Vera reads.
export function parseColor(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!HEX_COLOR.test(text)) return undefined;
    const digits = text.slice(1).toLowerCase();
    const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
    return `#${full}`;
}

// Brightness from 0 to 1 of a color the parser returned, ignoring alpha.
export function brightness(color: string): number {
    const channel = (start: number): number => Number.parseInt(color.slice(start, start + 2), 16);
    return (0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)) / 255;
}
