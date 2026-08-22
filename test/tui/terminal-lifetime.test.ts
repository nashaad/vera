import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { watchTerminalLoss } from "../../clients/tui/terminal-restore.ts";

class FakeTerminalStream extends EventEmitter {
    constructor(readonly isTTY: boolean) {
        super();
    }
}

describe("terminal lifetime", () => {
    test("stdin terminal loss closes the TUI once", () => {
        const stdin = new FakeTerminalStream(true);
        const stdout = new FakeTerminalStream(false);
        let losses = 0;

        watchTerminalLoss(() => losses++, stdin, stdout);
        stdin.emit("end");
        stdin.emit("close");

        expect(losses).toBe(1);
        expect(stdin.listenerCount("end")).toBe(0);
        expect(stdin.listenerCount("close")).toBe(0);
        expect(stdin.listenerCount("error")).toBe(0);
    });

    test("stdout terminal failure closes the TUI", () => {
        const stdin = new FakeTerminalStream(false);
        const stdout = new FakeTerminalStream(true);
        let losses = 0;

        watchTerminalLoss(() => losses++, stdin, stdout);
        stdout.emit("error", new Error("closed"));

        expect(losses).toBe(1);
        expect(stdout.listenerCount("close")).toBe(0);
        expect(stdout.listenerCount("error")).toBe(0);
    });

    test("explicit disposal disarms the watcher", () => {
        const stdin = new FakeTerminalStream(true);
        const stdout = new FakeTerminalStream(true);
        let losses = 0;

        const dispose = watchTerminalLoss(() => losses++, stdin, stdout);
        dispose();
        stdin.emit("close");
        stdout.emit("close");

        expect(losses).toBe(0);
    });

    test("non-terminal streams do not control TUI lifetime", () => {
        const stdin = new FakeTerminalStream(false);
        const stdout = new FakeTerminalStream(false);
        let losses = 0;

        watchTerminalLoss(() => losses++, stdin, stdout);
        stdin.emit("end");
        stdout.emit("close");

        expect(losses).toBe(0);
        expect(stdin.eventNames()).toEqual([]);
        expect(stdout.eventNames()).toEqual([]);
    });
});
