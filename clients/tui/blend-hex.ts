// No terminal imports: the docs site draws the activity bar with this too.
export function blendHex(base: string, dark: string, amount: number): string {
    const baseRgb = parseHex(base);
    const darkRgb = parseHex(dark);
    if (baseRgb === undefined || darkRgb === undefined) return base;
    const channel = (start: number, end: number) =>
        Math.round(start + (end - start) * amount)
            .toString(16)
            .padStart(2, "0");
    return `#${channel(baseRgb[0], darkRgb[0])}${
        channel(baseRgb[1], darkRgb[1])
    }${channel(baseRgb[2], darkRgb[2])}`;
}

function parseHex(color: string): readonly [number, number, number] | undefined {
    const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (match === null) return undefined;
    return [
        Number.parseInt(match[1] ?? "", 16),
        Number.parseInt(match[2] ?? "", 16),
        Number.parseInt(match[3] ?? "", 16),
    ];
}
