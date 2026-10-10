import { expect, test } from "bun:test";

import {
    parseFootprint,
    parseProcessMemory,
    readProcessMemory,
} from "../../clients/tui/process-memory.ts";

test("process memory parses ps RSS kilobytes into bytes", () => {
    expect(parseProcessMemory("  101  2048\n202 17\nnoise\n")).toEqual([
        { pid: 101, memoryBytes: 2 * 1024 * 1024 },
        { pid: 202, memoryBytes: 17 * 1024 },
    ]);
});

test("process memory reads phys_footprint per pid from footprint output", () => {
    const output = [
        "footprint: Unable to find pid for process matching '99999'",
        "======================================================================",
        "bun [101]: 64-bit    Footprint: 780087936 B (16384 bytes per page)",
        "======================================================================",
        "",
        "Auxiliary data:",
        "    phys_footprint: 780120704 B",
        "    phys_footprint_peak: 856251264 B",
        "",
        "======================================================================",
        "bun [202]: 64-bit    Footprint: 366318848 B (16384 bytes per page)",
        "======================================================================",
        "",
        "Auxiliary data:",
        "    phys_footprint: 366351616 B",
        "    phys_footprint_peak: 375837952 B",
        "",
        "Summary Footprint: 1146357632 B",
    ].join("\n");

    expect(parseFootprint(output)).toEqual([
        { pid: 101, memoryBytes: 780120704 },
        { pid: 202, memoryBytes: 366351616 },
    ]);
});

test("process memory samples this process on the current platform", async () => {
    const memory = await readProcessMemory([process.pid, 2 ** 31 - 2]);

    expect(memory.get(process.pid)).toBeGreaterThan(0);
    expect(memory.has(2 ** 31 - 2)).toBe(false);
});
