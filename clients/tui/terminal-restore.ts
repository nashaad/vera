import { writeSync } from "node:fs";
import { launcherKeyFromEnv, removeRelaunchRecord } from "../../src/release/relaunch.ts";
import { TERMINAL_INPUT_RESTORE_SEQUENCE, TERMINAL_RESTORE_SEQUENCE, TERMINAL_RESTORE_WITHOUT_KITTY_SEQUENCE } from "../../src/terminal-restore-sequence.ts";

interface TerminalLifetimeStream {
    readonly isTTY?: boolean;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    off(event: string, listener: (...args: unknown[]) => void): unknown;
}

let installed = false;
let screenAlreadyRestored = false;
let relaunchHandoff = false;
let kittyKeyboardEnabled = false;

function leaveRawMode(stdin: NodeJS.ReadStream): void {
    try {
        if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
        // A closed stdin must not stop the screen restore that follows.
    }
}

export function restoreRawInput(stdin: NodeJS.ReadStream): void {
    try {
        if (stdin.isTTY) {
            // Another process can change the tty while Bun still considers it raw.
            stdin.setRawMode(false);
            stdin.setRawMode(true);
        }
    } catch {
    }
}

export function restoreTerminalNow(
    tty: { readonly fd: number } = process.stdout,
    stdin: NodeJS.ReadStream = process.stdin,
): void {
    leaveRawMode(stdin);
    try {
        writeSync(tty.fd, TERMINAL_RESTORE_SEQUENCE);
    } catch {
    }
}

export function markKittyKeyboardEnabled(): void {
    kittyKeyboardEnabled = true;
}

// A second `?1049l` moves the cursor back over the shell prompt.
export function markTerminalRestored(mode?: "relaunch"): void {
    screenAlreadyRestored = true;
    relaunchHandoff = mode === "relaunch";
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
    let launcherKey: string | undefined;
    const restore = (): void => {
        if (screenAlreadyRestored) {
            leaveRawMode(stdin);
            if (relaunchHandoff) {
                relaunchHandoff = false;
                try {
                    writeSync(tty.fd, TERMINAL_INPUT_RESTORE_SEQUENCE);
                } catch {
                }
            }
            return;
        }
        screenAlreadyRestored = true;
        if (launcherKey !== undefined) {
            try {
                removeRelaunchRecord(launcherKey);
            } catch {
            }
        }
        if (kittyKeyboardEnabled) {
            restoreTerminalNow(tty, stdin);
        } else {
            leaveRawMode(stdin);
            try {
                writeSync(tty.fd, TERMINAL_RESTORE_WITHOUT_KITTY_SEQUENCE);
            } catch {
            }
        }
    };
    process.on("exit", restore);
    launcherKey = launcherKeyFromEnv();
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
