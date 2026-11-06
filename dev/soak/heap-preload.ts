import { appendFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.VERA_HOME;
if (!home || !home.includes("/vera-dev/")) {
    throw new Error("Heap sampling requires a trial home under the vera-dev temp directory");
}
const file = join(home, "soak-heap.jsonl");
const INTERVAL_MS = 500;

// Forced collection makes heapUsed reflect live objects, not the collector's timing.
setInterval(() => {
    const started = performance.now();
    Bun.gc(true);
    const gcMs = performance.now() - started;
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), heapUsed: process.memoryUsage().heapUsed, gcMs })}\n`);
}, INTERVAL_MS).unref();
