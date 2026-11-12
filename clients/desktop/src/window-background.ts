const MAX_LENGTH = 64;
const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/;

// Reduces a CSS color from the page to an opaque six-digit hex the window accepts.
// Hex digit order differs between CSS and the window API once alpha is present,
// so alpha is dropped here instead of being passed along.
export function parseWindowBackground(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length > MAX_LENGTH) return undefined;
    const text = value.trim();
    const hex = HEX.exec(text)?.[1];
    if (hex !== undefined) return fromHexDigits(hex);
    const channels = FUNCTIONAL.exec(text);
    if (channels === null) return undefined;
    const rgb = [channels[1], channels[2], channels[3]].map((channel) => Number(channel));
    return rgb.every((channel) => channel <= 255) ? toHex(rgb) : undefined;
}

function fromHexDigits(digits: string): string {
    const full = digits.length <= 4
        ? [...digits].map((digit) => `${digit}${digit}`).join("")
        : digits;
    return `#${full.slice(0, 6).toLowerCase()}`;
}

function toHex(channels: readonly number[]): string {
    return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
