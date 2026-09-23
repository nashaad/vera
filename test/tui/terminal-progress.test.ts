import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    stepTerminalProgress,
    TERMINAL_PROGRESS_BUSY,
    TERMINAL_PROGRESS_CLEAR,
    TERMINAL_PROGRESS_IDLE,
    terminalSupportsProgress,
} from "../../clients/tui/terminal-progress.ts";
import {
    restoreTerminalNow,
    setPendingTerminalRestore,
    TERMINAL_RESTORE_SEQUENCE,
} from "../../clients/tui/terminal-restore.ts";

test("only terminals known to draw the bar get the sequence", () => {
    expect(terminalSupportsProgress({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.0" }, true)).toBe(true);
    expect(terminalSupportsProgress({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.3.1-dev+abc" }, true)).toBe(true);
    expect(terminalSupportsProgress({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.1.9" }, true)).toBe(false);
    expect(terminalSupportsProgress({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.6" }, true)).toBe(true);
    expect(terminalSupportsProgress({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.14" }, true)).toBe(false);
    expect(terminalSupportsProgress({ ConEmuPID: "42" }, true)).toBe(true);
    expect(terminalSupportsProgress({ TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455" }, true)).toBe(false);
    expect(terminalSupportsProgress({ TERM_PROGRAM: "ghostty" }, true)).toBe(false);
});

test("Windows Terminal and a non-terminal stdout never get it", () => {
    expect(terminalSupportsProgress({ WT_SESSION: "x", ConEmuPID: "42" }, true)).toBe(false);
    expect(terminalSupportsProgress({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.0" }, false)).toBe(false);
});

test("busy is sent once, resent after five seconds, and cleared once", () => {
    const started = stepTerminalProgress(TERMINAL_PROGRESS_IDLE, true, 1_000);
    expect(started.sequence).toBe(TERMINAL_PROGRESS_BUSY);

    const steady = stepTerminalProgress(started.state, true, 5_999);
    expect(steady.sequence).toBeUndefined();
    const refreshed = stepTerminalProgress(steady.state, true, 6_000);
    expect(refreshed.sequence).toBe(TERMINAL_PROGRESS_BUSY);

    const cleared = stepTerminalProgress(refreshed.state, false, 7_000);
    expect(cleared.sequence).toBe(TERMINAL_PROGRESS_CLEAR);
    expect(stepTerminalProgress(cleared.state, false, 8_000).sequence).toBeUndefined();
});

test("an idle TUI that never showed the bar sends nothing", () => {
    expect(stepTerminalProgress(TERMINAL_PROGRESS_IDLE, false, 1_000).sequence).toBeUndefined();
});

test("the exit restore clears the bar only while it is showing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vera-progress-restore-")), "tty");
    const restoreInto = (): string => {
        const fd = openSync(path, "w");
        restoreTerminalNow({ fd }, { isTTY: false } as NodeJS.ReadStream);
        closeSync(fd);
        return readFileSync(path, "utf8");
    };

    expect(restoreInto()).toBe(TERMINAL_RESTORE_SEQUENCE);
    setPendingTerminalRestore(TERMINAL_PROGRESS_CLEAR);
    expect(restoreInto()).toBe(TERMINAL_RESTORE_SEQUENCE + TERMINAL_PROGRESS_CLEAR);
    setPendingTerminalRestore("");
    expect(restoreInto()).toBe(TERMINAL_RESTORE_SEQUENCE);
});
