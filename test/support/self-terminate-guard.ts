/**
 * Ends a tmux-driven TUI test child that outlives what started it.
 *
 * These fixtures hold nothing but a render loop and rely entirely on tmux
 * kill-server to reach them. tmux normally signals the pane's process group,
 * but a pane whose shell was never replaced by `exec` runs bun as a child the
 * signal can miss; the process is then reparented to init/launchd and spins
 * its render loop at full tilt forever. Calling this gives the process its
 * own way out: it notices its terminal is gone, takes SIGHUP/SIGTERM as a
 * request to stop rather than something a raw-mode input handler can
 * swallow, and gives up outright past a hard deadline.
 *
 * Call this only from a fixture's own `if (import.meta.main)` entry point
 * (first, before anything that might install competing signal handlers --
 * `process.exit()` inside a listener runs synchronously and cuts off
 * listeners registered after it, so registering first wins the race). A
 * fixture that exports helpers for the in-process "driven" suites to import
 * must never call this at module scope: it would install these handlers
 * inside the live `bun test` runner, not a disposable child process.
 */
const PARENT_POLL_MS = 2_000;
const MAX_LIFETIME_MS = 5 * 60_000;

export function installTestProcessGuard(): void {
    const parentPoll = setInterval(() => {
        if (process.ppid === 1) process.exit(0);
    }, PARENT_POLL_MS);
    parentPoll.unref();

    process.once("SIGHUP", () => process.exit(0));
    process.once("SIGTERM", () => process.exit(0));

    const deadline = setTimeout(() => process.exit(1), MAX_LIFETIME_MS);
    deadline.unref();
}
