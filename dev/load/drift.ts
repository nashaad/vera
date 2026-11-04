import { appendFileSync } from "node:fs";

const path = process.env.LOAD_DRIFT_FILE;
if (!path || !process.env.VERA_HOME?.includes("/vera-dev/")) {
    throw new Error("Drift sampling requires a trial home and output file");
}
let previous = performance.now();
setInterval(() => {
    const now = performance.now();
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), delayMs: Math.max(0, now - previous - 50) })}\n`);
    previous = now;
}, 50).unref();
