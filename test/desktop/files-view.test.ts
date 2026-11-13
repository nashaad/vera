import { expect, test } from "bun:test";

import {
    byteSize,
    childPath,
    EMPTY_FILE_HISTORY,
    gutterText,
    lineCount,
    MAX_FILE_HISTORY,
    openedFile,
    openInHistory,
    pathUnder,
    stepHistory,
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

test("@core the gutter numbers each line, and a final newline adds none", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("feathers")).toBe(1);
    expect(lineCount("feathers\nmud\n")).toBe(2);
    expect(lineCount("feathers\nmud")).toBe(2);
    expect(lineCount("\n\n")).toBe(2);
    expect(gutterText(3)).toBe("1\n2\n3");
    expect(gutterText(0)).toBe("");
});

test("sizes read in bytes, kilobytes or megabytes", () => {
    expect(byteSize(12)).toBe("12 B");
    expect(byteSize(256 * 1024)).toBe("256 KB");
    expect(byteSize(1_300_000)).toBe("1.2 MB");
});

test("@core opened files step back and forward, and a new file drops the ones ahead", () => {
    let history = openInHistory(EMPTY_FILE_HISTORY, "/nest/egg.txt");
    history = openInHistory(history, "/nest/doubloon.txt");
    expect(openInHistory(history, "/nest/doubloon.txt")).toBe(history);
    expect(stepHistory(history, 1)).toBe(history);
    history = stepHistory(history, -1);
    expect(openedFile(history)).toBe("/nest/egg.txt");
    expect(stepHistory(history, -1)).toBe(history);
    expect(openedFile(stepHistory(history, 1))).toBe("/nest/doubloon.txt");
    history = openInHistory(history, "/nest/map.txt");
    expect(history.paths).toEqual(["/nest/egg.txt", "/nest/map.txt"]);
    expect(openedFile(EMPTY_FILE_HISTORY)).toBeUndefined();
});

test("opened files keep only the newest ones", () => {
    let history = EMPTY_FILE_HISTORY;
    for (let index = 0; index < MAX_FILE_HISTORY + 5; index += 1) history = openInHistory(history, `/nest/${index}.txt`);
    expect(history.paths.length).toBe(MAX_FILE_HISTORY);
    expect(history.paths[0]).toBe("/nest/5.txt");
    expect(openedFile(history)).toBe(`/nest/${MAX_FILE_HISTORY + 4}.txt`);
});
