const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function displayOffsetWidth(value: string): number {
    let width = 0;
    for (const part of graphemes.segment(value)) {
        width += part.segment === "\n" ? 1 : Bun.stringWidth(part.segment);
    }
    return width;
}

/** Convert an OpenTUI display-column offset to a JavaScript string index. */
export function stringIndexAtDisplayOffset(
    value: string,
    offset: number,
): number {
    if (offset <= 0) return 0;
    let width = 0;
    for (const part of graphemes.segment(value)) {
        const next = width + (part.segment === "\n"
            ? 1
            : Bun.stringWidth(part.segment));
        if (next > offset) return part.index;
        width = next;
        if (width === offset) return part.index + part.segment.length;
    }
    return value.length;
}

export interface ImageChip {
    readonly requestId: string;
    readonly marker: string;
}

export interface PlacedImageChip extends ImageChip {
    readonly start: number;
    readonly end: number;
}

export interface RenumberedImageChips {
    readonly text: string;
    readonly chips: readonly PlacedImageChip[];
}

export function imageChipMarker(position: number): string {
    return `[Image ${position}]`;
}

export function renumberImageChips(
    text: string,
    chips: readonly ImageChip[],
): RenumberedImageChips {
    let rewritten = "";
    let restIndex = 0;
    let position = 0;
    const placed: PlacedImageChip[] = [];

    for (const chip of chips) {
        const markerIndex = text.indexOf(chip.marker, restIndex);
        if (markerIndex === -1) continue;
        position += 1;
        const marker = imageChipMarker(position);
        rewritten += text.slice(restIndex, markerIndex);
        const start = displayOffsetWidth(rewritten);
        rewritten += marker;
        placed.push({
            requestId: chip.requestId,
            marker,
            start,
            end: displayOffsetWidth(rewritten),
        });
        restIndex = markerIndex + chip.marker.length;
    }

    return { text: rewritten + text.slice(restIndex), chips: placed };
}

export function stripImageChips(
    text: string,
    chips: readonly ImageChip[],
): string {
    let stripped = "";
    let restIndex = 0;

    for (const chip of chips) {
        const markerIndex = text.indexOf(chip.marker, restIndex);
        if (markerIndex === -1) continue;
        stripped += text.slice(restIndex, markerIndex);
        restIndex = markerIndex + chip.marker.length;
        if (text[restIndex] === " ") restIndex += 1;
    }

    return (stripped + text.slice(restIndex)).trim();
}
