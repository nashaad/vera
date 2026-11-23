import { expect, test } from "bun:test";

import {
    byteSize,
    childPath,
    pathUnder,
} from "../../clients/ui/src/views/files.ts";

test("@core a file's path is shown below the session folder", () => {
    expect(childPath("/nest", "hold")).toBe("/nest/hold");
    expect(childPath("/", "nest")).toBe("/nest");
    expect(childPath("C:\\nest", "hold")).toBe("C:\\nest\\hold");
    expect(pathUnder("/nest", "/nest/hold/doubloon.txt")).toBe("hold/doubloon.txt");
    expect(pathUnder("/nest/", "/nest/egg.txt")).toBe("egg.txt");
    expect(pathUnder("/nest", "/nestling/egg.txt")).toBe("/nestling/egg.txt");
    expect(pathUnder("C:\\nest", "C:\\nest\\egg.txt")).toBe("egg.txt");
});

test("sizes read in bytes, kilobytes or megabytes", () => {
    expect(byteSize(12)).toBe("12 B");
    expect(byteSize(256 * 1024)).toBe("256 KB");
    expect(byteSize(1_300_000)).toBe("1.2 MB");
});
