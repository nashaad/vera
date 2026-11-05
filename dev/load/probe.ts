import { existsSync } from "node:fs";
import { join } from "node:path";
import { attachAgent } from "../../src/host/attached-client.ts";
import { PAGING_CAPABILITIES } from "../../src/host/capabilities.ts";
import { connectHost } from "../../src/host/connection.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { assertTrialHome, command, log, waitFor } from "./common.ts";

// The probe attaches the largest session, whose history exceeds 64 MiB.
const HISTORY_FRAME_BYTES = 256 * 1_024 * 1_024;
// Receiving that history takes over 30 s on an idle machine.
const ATTACH_TIMEOUT_MS = 300_000;

const home = assertTrialHome();
const run = process.env.LOAD_RUN!;
const pid = Number(process.env.LOAD_HOST_PID);
const socketPath = join(home, "runtime", "host.sock");
const output = join(run, "probe.ndjson");
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
await waitFor(() => existsSync(join(run, "go.json")), 300_000, "probe barrier");
const { end } = await Bun.file(join(run, "go.json")).json() as { end: number };
async function periodic(interval: number, task: () => Promise<void>): Promise<void> {
    let next = Date.now();
    while (!stopping && Date.now() < end) {
        try { await task(); } catch (error) { log(output, { type: "error", error: String(error), interval }); }
        next += interval;
        const delay = next - Date.now();
        if (delay < 0) { log(output, { type: "missed_tick", interval, behindMs: -delay }); next = Date.now(); }
        else await Bun.sleep(delay);
    }
}
await Promise.all([
    periodic(500, async () => {
        const start = performance.now();
        const identity = await requestHostIdentity(socketPath);
        log(output, { type: "identity", ms: performance.now() - start, ok: identity !== undefined });
        // Keep a second connection open beyond the CLI deadline to measure late answers.
        const connection = await connectHost({ socketPath });
        const lateStart = performance.now();
        try {
            await connection.send({ type: "host_identity" });
            const response = await connection.receiveWithin(10_000, "Identity response deadline") as { type: string };
            log(output, { type: "identity_uncapped", ms: performance.now() - lateStart, ok: response.type === "host_identity" });
        } finally { connection.close(); }
    }),
    periodic(2000, async () => {
        const start = performance.now();
        const agents = await listAgentsThroughHost(socketPath, 10_000);
        log(output, { type: "diagnostics", ms: performance.now() - start, agents: agents.length,
            working: agents.filter((agent) => agent.status === "working").length,
            workers: agents.filter((agent) => agent.worker_pid !== undefined).length });
    }),
    periodic(10_000, async () => {
        const start = performance.now();
        const client = await attachAgent({ socketPath, agentId: process.env.LOAD_ATTACH_ID!, maxLineBytes: HISTORY_FRAME_BYTES, ...(process.env.LOAD_PAGING === "1" ? { requestedCapabilities: PAGING_CAPABILITIES } : {}), signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS) });
        try {
            while ((await client.receive(AbortSignal.timeout(ATTACH_TIMEOUT_MS))).type !== "history") {}
            log(output, { type: "attach", ms: performance.now() - start });
        } finally { client.close(); }
    }),
    periodic(1000, async () => {
        const sample = (await command(["/bin/ps", "-p", String(pid), "-o", "%cpu=,rss="])).trim().split(/\s+/).map(Number);
        const processes = await command(["/bin/ps", "-axo", "pid=,ppid=,command="]);
        const children = processes.split("\n").flatMap((line) => {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
            return match && Number(match[2]) === pid ? [{ pid: Number(match[1]), command: match[3] }] : [];
        });
        log(output, { type: "process", cpu: sample[0], rssBytes: sample[1]! * 1024, children });
    }),
]);
