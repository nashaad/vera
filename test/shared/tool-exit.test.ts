import { expect, test } from "bun:test";

import {
    toolExitCode,
    toolExitSummary,
    toolFailed,
} from "../../clients/shared/tool-exit.ts";

test("@core observed exits do not hide real errors or withheld calls", () => {
    expect(toolExitCode({ exitCode: 2, isError: true })).toBe(2);
    expect(toolFailed({ exitCode: 2, isError: true })).toBe(false);
    expect(toolExitCode({ exitCode: 0, isError: false })).toBeUndefined();
    expect(toolFailed({ exitCode: 0, isError: true })).toBe(true);
    expect(toolFailed({ isError: true })).toBe(true);
    expect(toolExitCode({ exitCode: 2, isError: true, withheld: true })).toBeUndefined();
    expect(toolFailed({ exitCode: 2, isError: true, withheld: true })).toBe(false);
});

test("@core exit summaries count repeats and cap distinct codes", () => {
    expect(toolExitSummary([
        { exitCode: 2 },
        { exitCode: 7 },
        { exitCode: 2 },
        { exitCode: 4 },
        { exitCode: 9 },
        { exitCode: 9 },
        { exitCode: 11 },
        { exitCode: 0 },
        { exitCode: 12, withheld: true },
        { isError: true },
    ])).toEqual(["exit 2 ×2", "exit 7", "exit 4", "+2"]);
});
