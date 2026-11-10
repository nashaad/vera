import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const run = process.env.LOAD_RUN;
if (!run || !process.env.VERA_HOME?.includes("/vera-dev/")) {
    throw new Error("Drift sampling requires a trial home and output file");
}
const workerArgument = process.argv.indexOf("--worker-index");
const workerIndex = workerArgument === -1 ? undefined : Number(process.argv[workerArgument + 1]);
const host = process.argv.some((arg) => arg.endsWith("/clients/host/main.ts"));
if (host || workerIndex !== undefined) {
    const path = host ? join(run, "drift.ndjson") : join(run, `drift-worker-${process.pid}.ndjson`);
    let previous = performance.now();
    let pending = "";
    const flush = (): void => {
        if (pending.length === 0) return;
        appendFileSync(path, pending);
        pending = "";
    };
    setInterval(() => {
        const now = performance.now();
        pending += `${JSON.stringify({ at: Date.now(), pid: process.pid, delayMs: Math.max(0, now - previous - 50) })}\n`;
        previous = now;
    }, 50).unref();
    setInterval(flush, 1_000).unref();
    process.once("exit", flush);
    if (workerIndex === 0 && process.env.LOAD_PIN_WORKER === "1") {
        const go = join(run, "go.json");
        const pinPath = join(run, "pin.ndjson");
        const timer = setInterval(() => {
            if (!existsSync(go)) return;
            clearInterval(timer);
            if (existsSync(pinPath)) return;
            const { end } = JSON.parse(readFileSync(go, "utf8")) as { end: number };
            let stopped = false;
            let iterations = 0;
            const stop = (): void => { stopped = true; };
            process.once("SIGTERM", stop);
            process.once("SIGINT", stop);
            const spin = (): void => {
                if (stopped || Date.now() >= end) {
                    process.removeListener("SIGTERM", stop);
                    process.removeListener("SIGINT", stop);
                    appendFileSync(pinPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, worker: workerIndex, type: "end", iterations })}\n`);
                    return;
                }
                const until = performance.now() + 150;
                while (performance.now() < until) {}
                iterations += 1;
                setTimeout(spin, 8).unref();
            };
            appendFileSync(pinPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, worker: workerIndex, type: "start" })}\n`);
            spin();
        }, 50);
        timer.unref();
    }
}
