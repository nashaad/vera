const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The width a string occupies in textarea offsets.
 *
 * Extmark and cursor offsets are display columns, not string indices, and a
 * newline counts as one column where `Bun.stringWidth` counts it as none.
 */
export function displayOffsetWidth(value: string): number {
    let width = 0;
    for (const part of graphemes.segment(value)) {
        width += part.segment === "\n" ? 1 : Bun.stringWidth(part.segment);
    }
    return width;
}

export interface ImageChip {
    /** The `attach_image` request this chip stands for. */
    readonly requestId: string;
    /** The text in the composer, such as `[Image 2]`. */
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

/**
 * Rewrite the composer text so surviving chips read 1, 2, 3 in document order.
 *
 * Chips are found by searching for their current marker rather than by their
 * recorded offsets, because a chip's offsets are stale the moment any earlier
 * chip is renamed to a different width.
 */
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

/** The prompt as typed, with the chips removed. */
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
        // A chip is inserted with a trailing space that belongs to the chip,
        // not to the prompt.
        if (text[restIndex] === " ") restIndex += 1;
    }

    return (stripped + text.slice(restIndex)).trim();
}
