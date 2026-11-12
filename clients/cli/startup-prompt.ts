import { homedir } from "node:os";

import {
    renderStartupCard,
    renderStartupChoiceEcho,
    startupCardStyle,
    type StartupCard,
    type StartupCardStyle,
} from "./startup-card.ts";

export interface KeyInput {
    readonly isTTY?: boolean;
    setRawMode?(mode: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface CardStreams {
    readonly stdin: KeyInput;
    readonly stdout: { readonly isTTY?: boolean };
    readonly stderr: {
        readonly isTTY?: boolean;
        readonly columns?: number;
        write(text: string): unknown;
    };
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly home: string | undefined;
}

export interface CardPresenter {
    show(card: StartupCard): void;
    // Draws the card and waits for one key: y is yes; Escape, Ctrl+C and n are no. Enter takes
    // the default choice, which is no unless the card marks y as the default.
    ask(card: StartupCard): Promise<boolean>;
    // The card's colour and width settings, for follow-up text drawn in the same style.
    readonly style: StartupCardStyle;
}

/**
 * Cards are for a person at a terminal. Anything piped, redirected or
 * non-interactive gets undefined and keeps printing the plain text.
 */
export function terminalCardPresenter(
    streams: CardStreams | undefined = processStreams(),
): CardPresenter | undefined {
    if (
        streams === undefined
        || streams.stdin.isTTY !== true
        || streams.stdout.isTTY !== true
        || streams.stderr.isTTY !== true
    ) {
        return undefined;
    }
    const style = startupCardStyle(streams.env, streams.stderr.columns, streams.home);
    const show = (card: StartupCard) => {
        streams.stderr.write(`\n${renderStartupCard(card, style)}`);
    };
    return {
        style,
        show,
        ask: async (card) => {
            show(card);
            const yes = await readYesNoKey(
                streams.stdin,
                card.choices?.some((item) => item.key === "y" && item.isDefault === true) === true,
            );
            const key = yes ? "y" : "n";
            const choice = card.choices?.find((item) => item.key.toLowerCase() === key);
            if (choice !== undefined) {
                streams.stderr.write(renderStartupChoiceEcho(choice, style));
            }
            return yes;
        },
    };
}

// Reading a standard stream can throw when it was redirected to a device Bun cannot poll.
function processStreams(): CardStreams | undefined {
    try {
        return {
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
            env: process.env,
            home: homedir(),
        };
    } catch {
        return undefined;
    }
}

/**
 * Reads one key in raw mode. The terminal goes back to its previous mode on
 * every exit: a key, end of input, a stream error or the process exiting.
 */
export function readYesNoKey(input: KeyInput, enterIsYes = false): Promise<boolean> {
    return new Promise((resolve) => {
        let raw = false;
        const restore = () => {
            if (!raw) return;
            raw = false;
            try {
                input.setRawMode?.(false);
            } catch {
                // The terminal is already gone.
            }
        };
        const finish = (answer: boolean) => {
            input.off("data", onData);
            input.off("end", onEnd);
            input.off("close", onEnd);
            input.off("error", onEnd);
            process.off("exit", restore);
            restore();
            input.pause();
            resolve(answer);
        };
        const onData = (chunk: Uint8Array | string) => {
            const answer = answerForKey(chunk.toString(), enterIsYes);
            if (answer !== undefined) finish(answer);
        };
        const onEnd = () => finish(false);
        try {
            input.setRawMode?.(true);
            raw = true;
        } catch {
            // Without raw mode the answer is read as a line; the first character still decides.
        }
        process.once("exit", restore);
        input.on("data", onData);
        input.on("end", onEnd);
        input.on("close", onEnd);
        input.on("error", onEnd);
        input.resume();
    });
}

// An arrow key arrives as an escape sequence; only a lone Escape is an answer.
function answerForKey(text: string, enterIsYes: boolean): boolean | undefined {
    if (text === "\u001b") return false;
    if (text.startsWith("\u001b")) return undefined;
    const key = text[0];
    if (key === "y" || key === "Y") return true;
    if (key === "\r" || key === "\n") return enterIsYes;
    if (key === "n" || key === "N" || key === "\u0003") return false;
    return undefined;
}
