import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";

import type { StartupCard } from "../clients/cli/startup-card.ts";
import {
    readYesNoKey,
    terminalCardPresenter,
    type CardStreams,
} from "../clients/cli/startup-prompt.ts";

class FakeInput extends EventEmitter {
    isTTY = true;
    rawModes: boolean[] = [];
    paused = false;
    failRaw = false;

    setRawMode(mode: boolean): void {
        if (this.failRaw && mode) throw new Error("no raw mode");
        this.rawModes.push(mode);
    }

    resume(): void {
        this.paused = false;
    }

    pause(): void {
        this.paused = true;
    }

    press(text: string): void {
        this.emit("data", Buffer.from(text));
    }
}

async function answer(keys: readonly string[]): Promise<{ yes: boolean; input: FakeInput }> {
    const input = new FakeInput();
    const pending = readYesNoKey(input);
    for (const key of keys) input.press(key);
    return { yes: await pending, input };
}

test("y and Y answer yes", async () => {
    expect((await answer(["y"])).yes).toBe(true);
    expect((await answer(["Y"])).yes).toBe(true);
});

test("n, N, Enter, Escape and Ctrl+C answer no", async () => {
    for (const key of ["n", "N", "\r", "\n", "\u001b", "\u0003"]) {
        expect((await answer([key])).yes, JSON.stringify(key)).toBe(false);
    }
});

test("other keys and arrow sequences are ignored until a real answer", async () => {
    expect((await answer(["x", "\u001b[A", " ", "y"])).yes).toBe(true);
    expect((await answer(["q", "\u001b[B", "n"])).yes).toBe(false);
});

test("raw mode is turned on for the read and off after it", async () => {
    const { input } = await answer(["y"]);
    expect(input.rawModes).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
});

test("raw mode is restored when input ends without a key", async () => {
    const input = new FakeInput();
    const pending = readYesNoKey(input);
    input.emit("end");
    expect(await pending).toBe(false);
    expect(input.rawModes).toEqual([true, false]);
});

test("a stream error answers no and restores the terminal", async () => {
    const input = new FakeInput();
    const pending = readYesNoKey(input);
    input.emit("error", new Error("EIO"));
    expect(await pending).toBe(false);
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount("error")).toBe(0);
});

test("a terminal that refuses raw mode still answers on the first character", async () => {
    const input = new FakeInput();
    input.failRaw = true;
    const pending = readYesNoKey(input);
    input.press("yes\n");
    expect(await pending).toBe(true);
    expect(input.rawModes).toEqual([]);
});

function streams(overrides: Partial<{ stdin: boolean; stdout: boolean; stderr: boolean }> = {}): {
    readonly streams: CardStreams;
    readonly input: FakeInput;
    readonly written: string[];
} {
    const input = new FakeInput();
    input.isTTY = overrides.stdin ?? true;
    const written: string[] = [];
    return {
        input,
        written,
        streams: {
            stdin: input,
            stdout: { isTTY: overrides.stdout ?? true },
            stderr: {
                isTTY: overrides.stderr ?? true,
                columns: 48,
                write: (text) => { written.push(text); },
            },
            env: { NO_COLOR: "1" },
            home: "/Users/nash",
        },
    };
}

const card: StartupCard = {
    kind: "question",
    title: "Reset the host?",
    choices: [
        { key: "y", label: "reset" },
        { key: "n", label: "quit", isDefault: true },
    ],
};

test("no presenter is made unless stdin, stdout and stderr are all terminals", () => {
    expect(terminalCardPresenter(streams({ stdin: false }).streams)).toBeUndefined();
    expect(terminalCardPresenter(streams({ stdout: false }).streams)).toBeUndefined();
    expect(terminalCardPresenter(streams({ stderr: false }).streams)).toBeUndefined();
    expect(terminalCardPresenter(streams().streams)).toBeDefined();
});

test("ask draws the card, reads a key and echoes the choice", async () => {
    const { streams: terminal, input, written } = streams();
    const presenter = terminalCardPresenter(terminal)!;
    const pending = presenter.ask(card);
    expect(written.join("")).toContain("│ ? Reset the host?");
    expect(written.join("")).toContain("[y] reset      [N] quit");
    input.press("y");
    expect(await pending).toBe(true);
    expect(written[written.length - 1]).toBe("  [y] reset\n");
});

test("ask echoes the default choice for Enter", async () => {
    const { streams: terminal, input, written } = streams();
    const pending = terminalCardPresenter(terminal)!.ask(card);
    input.press("\r");
    expect(await pending).toBe(false);
    expect(written[written.length - 1]).toBe("  [N] quit\n");
});
