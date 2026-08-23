import { expect, test } from "bun:test";

import { parseProcessMemory } from "../../clients/tui/process-memory.ts";

test("process memory parses ps RSS kilobytes into bytes", () => {
    expect(parseProcessMemory("  101  2048\n202 17\nnoise\n")).toEqual([
        { pid: 101, rssBytes: 2 * 1024 * 1024 },
        { pid: 202, rssBytes: 17 * 1024 },
    ]);
});
