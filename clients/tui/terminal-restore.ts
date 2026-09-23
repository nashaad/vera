import { writeSync } from "node:fs";

interface TerminalLifetimeStream {
    readonly isTTY?: boolean;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Undoes every terminal mode the renderer switches on: alternate screen, hidden cursor, mouse tracking, bracketed paste, kitty keyboard flags, and colors. */
export const TERMINAL_RESTORE_SEQUENCE = "\x1b[?1049l" // main screen
    + "\x1b[?25h" // show cursor
    + "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" // mouse tracking off
    + "\x1b[?2004l" // bracketed paste off
    + "\x1b[<u" // pop kitty keyboard flags
    + "\x1b[0m"; // reset colors and attributes

let installed = false;
// Set only while a mode outside the renderer is on, such as the progress bar.
let pendingRestore = "";

export function setPendingTerminalRestore(sequence: string): void {
    pendingRestore = sequence;
}

export function restoreTerminalNow(
    tty: { readonly fd: number } = process.stdout,
    stdin: NodeJS.ReadStream = process.stdin,
): void {
    try {
        if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
        // A closed stdin must not stop the screen restore below.
    }
    try {
        writeSync(tty.fd, TERMINAL_RESTORE_SEQUENCE + pendingRestore);
    } catch {
    }
}

/** Destroys a live TUI when the terminal underneath it disappears without a usable SIGHUP. */
export function watchTerminalLoss(
    onLost: () => void,
    stdin: TerminalLifetimeStream = process.stdin,
    stdout: TerminalLifetimeStream = process.stdout,
): () => void {
    const subscriptions: Array<{
        readonly stream: TerminalLifetimeStream;
        readonly event: string;
    }> = [];
    if (stdin.isTTY === true) {
        subscriptions.push(
            { stream: stdin, event: "end" },
            { stream: stdin, event: "close" },
            { stream: stdin, event: "error" },
        );
    }
    if (stdout.isTTY === true) {
        subscriptions.push(
            { stream: stdout, event: "close" },
            { stream: stdout, event: "error" },
        );
    }

    let active = subscriptions.length > 0;
    const dispose = (): void => {
        if (!active) return;
        active = false;
        for (const subscription of subscriptions) {
            subscription.stream.off(subscription.event, lost);
        }
    };
    const lost = (): void => {
        if (!active) return;
        dispose();
        onLost();
    };
    for (const subscription of subscriptions) {
        subscription.stream.on(subscription.event, lost);
    }
    return dispose;
}

export function installTerminalRestoreOnExit(
    tty: { readonly fd: number; readonly isTTY?: boolean } = process.stdout,
    stdin: NodeJS.ReadStream = process.stdin,
): void {
    if (installed || (tty.isTTY !== true && stdin.isTTY !== true)) return;
    installed = true;
    const restore = (): void => restoreTerminalNow(tty, stdin);
    process.on("exit", restore);
    for (const signal of ["SIGHUP", "SIGTERM", "SIGQUIT"] as const) {
        const onSignal = (): void => {
            restore();
            process.off(signal, onSignal);
            if (process.listenerCount(signal) === 0) {
                process.kill(process.pid, signal);
            }
        };
        process.on(signal, onSignal);
    }
}
