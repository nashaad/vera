/**
 * A worker that cannot be asked to stop.
 *
 * It replaces the default handlers for every catchable termination signal with
 * handlers that do nothing, then blocks the main thread in `Atomics.wait` on a
 * value that never changes. The event loop never turns again, so nothing it
 * was sent, signal or message, is ever observed. Only SIGKILL ends it.
 *
 * Prints its pid and the word ready before wedging, so a test knows when the
 * blocking call has been entered rather than guessing from a sleep.
 */

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    process.on(signal, () => {
        // Deliberately nothing.
    });
}

process.stdout.write(`${process.pid} ready\n`);

const shared = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(shared, 0, 0);

process.stdout.write("unreachable\n");
