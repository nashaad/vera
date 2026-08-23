/**
 * A stand-in host for the dead man's switch test. It spawns a real supervisor
 * over a real pipe, prints the supervisor's pid, and then does nothing, so the
 * test can SIGKILL it and watch what the supervisor does when the pipe on the
 * other end goes away.
 *
 * Usage: bun crashing-host.ts <worker-pid> <deadline-ms>
 */

import { superviseWorker } from "../../../src/host/worker-supervisor-handle.ts";

const workerPid = Number(process.argv[2]);
const deadlineMs = Number(process.argv[3]);

const handle = superviseWorker({ pid: workerPid, deadlineMs });

process.stdout.write(`${handle.pid} supervisor\n`);

setInterval(() => {
    // Keeps this process alive until the test kills it.
}, 60_000);
