import { expect, test } from "bun:test";
import { clampFilesTree, filesSplitBounds } from "../../clients/ui/src/views/files-split.ts";

test("Files split bounds fit narrow and wide containers", () => {
    const wide = filesSplitBounds(800, 4);
    expect(wide).toEqual({ min: 120, max: 640, defaultWidth: 280 });
    expect(clampFilesTree(20, wide)).toBe(120);
    expect(clampFilesTree(900, wide)).toBe(640);
    const narrow = filesSplitBounds(140, 4);
    expect(narrow).toEqual({ min: 60, max: 60, defaultWidth: 60 });
    expect(filesSplitBounds(0, 4)).toEqual({ min: 0, max: 0, defaultWidth: 0 });
});
