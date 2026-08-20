import { writeSync } from "node:fs";

/**
 * Undoes every terminal mode the renderer switches on: alternate screen,
 * hidden cursor, mouse tracking, bracketed paste, kitty keyboard flags, and
 * colors. Harmless when a mode was never set, so it is safe to write blind.
 */
export const TERMINAL_RESTORE_SEQUENCE = "\x1b[?1049l" // main screen
    + "\x1b[?25h" // show cursor
    + "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" // mouse tracking off
    + "\x1b[?2004l" // bracketed paste off
    + "\x1b[<u" // pop kitty keyboard flags
    + "\x1b[0m"; // reset colors and attributes

let installed = false;

/**
 * Restores the terminal on process exit without going through the renderer,
 * which may be the thing that crashed. The "exit" event fires on clean
 * returns and on uncaught exceptions alike; only synchronous work runs there,
 * and both calls here are synchronous. Writing the restore twice is harmless,
 * so this does not coordinate with the renderer's own clean shutdown.
 */
export function installTerminalRestoreOnExit(
    tty: { readonly fd: number; readonly isTTY?: boolean } = process.stdout,
    stdin: NodeJS.ReadStream = process.stdin,
): void {
    // Either stream being a terminal is enough. Raw mode is set on stdin, and
    // that is the mode that strands a user, so `vera | tee log` still needs
    // the restore even though stdout is a pipe.
    if (installed || (tty.isTTY !== true && stdin.isTTY !== true)) return;
    installed = true;
    const restore = (): void => {
        try {
            if (stdin.isTTY) stdin.setRawMode(false);
        } catch {
            // A closed stdin must not stop the screen restore below.
        }
        try {
            writeSync(tty.fd, TERMINAL_RESTORE_SEQUENCE);
        } catch {
            // The tty may already be gone; there is nothing left to restore.
        }
    };
    process.on("exit", restore);
    // A signal with its default disposition ends the process without an "exit"
    // event, so closing the terminal or killing the TUI would otherwise leave
    // the alternate screen and hidden cursor behind. Restoring and then
    // re-raising keeps the exit status a caller sees truthful.
    for (const signal of ["SIGHUP", "SIGTERM", "SIGQUIT"] as const) {
        const onSignal = (): void => {
            restore();
            process.off(signal, onSignal);
            // Re-raising is what turns this back into the death the signal
            // asked for, but only once nothing else is listening: another
            // handler means the process has its own plan for this signal, and
            // re-raising would preempt it.
            if (process.listenerCount(signal) === 0) {
                process.kill(process.pid, signal);
            }
        };
        process.on(signal, onSignal);
    }
}
