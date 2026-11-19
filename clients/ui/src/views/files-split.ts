export interface FilesSplitBounds {
    readonly min: number;
    readonly max: number;
    readonly defaultWidth: number;
}

export function filesSplitBounds(width: number, space: number): FilesSplitBounds {
    const available = Math.max(0, width);
    const scale = Math.min(1, available / 280);
    const min = 120 * scale;
    const max = Math.max(min, available - 160 * scale);
    return {
        min,
        max,
        defaultWidth: Math.min(max, Math.max(min, Math.min(space * 70, Math.max(space * 40, available * 0.4)))),
    };
}

export function clampFilesTree(width: number, bounds: FilesSplitBounds): number {
    return Math.min(bounds.max, Math.max(bounds.min, width));
}
