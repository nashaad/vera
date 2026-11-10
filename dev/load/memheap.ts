import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heapStats } from "bun:jsc";

const run = process.env.LOAD_RUN;
if (!run || !process.env.VERA_HOME?.includes("/vera-dev/")) throw new Error("Memory sampling requires a trial home");
const isHost = process.argv.some((arg) => arg.endsWith("/clients/host/main.ts"));
const isWorker = process.argv.includes("--worker-index");
if (isHost || isWorker) {
    let lastPhase = "";
    let lastSample = 0;
    const sample = (phase: string): void => {
        Bun.gc(true);
        const stats = heapStats();
        const memory = process.memoryUsage();
        const footprint = Bun.spawnSync(["/usr/bin/footprint", "-p", String(process.pid)]).stdout.toString();
        appendFileSync(join(run, `memheap-${process.pid}.ndjson`), JSON.stringify({
            at: Date.now(), pid: process.pid, phase, memory, footprint,
            heapSize: stats.heapSize, heapCapacity: stats.heapCapacity, extraMemorySize: stats.extraMemorySize,
            objectTypeCounts: stats.objectTypeCounts,
        }) + "\n");
        lastSample = Date.now();
    };
    const timer = setInterval(() => {
        const request = join(run, "memheap-phase");
        const phase = existsSync(request) ? readFileSync(request, "utf8") : "";
        if (phase && phase !== lastPhase) {
            lastPhase = phase;
            sample(phase);
            if (isHost && process.env.LOAD_MEMHEAP_SNAPSHOT === "1" && (phase === "ready" || phase === "end")) {
                const snapshot = Bun.generateHeapSnapshot();
                writeFileSync(join(run, `heap-${phase}.json`), JSON.stringify(snapshot));
            }
            writeFileSync(join(run, `memheap-${phase}-${process.pid}.done`), "");
        } else if (Date.now() - lastSample >= 10_000) sample("sample");
    }, 200);
    timer.unref();
}
