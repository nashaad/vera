import { existsSync } from "node:fs";
import { join } from "node:path";
import { attachAgent } from "../../src/host/attached-client.ts";
import type { ReadyAgent } from "../../src/host/agent-start-client.ts";
import { CLIENT_CAPABILITIES, HOST_CAPABILITY_SESSION_ROUTING, HOST_CAPABILITY_WORK_INDEX, PAGING_CAPABILITIES } from "../../src/host/capabilities.ts";
import { connectHost } from "../../src/host/connection.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import { assertTrialHome, command, log, rows, waitFor } from "./common.ts";
import { observeAttachments } from "./attachments.ts";
import { processReadings, sampleFootprints } from "./metrics.ts";

const HISTORY_FRAME_BYTES = 256 * 1_024 * 1_024;
// Receiving that history takes over 30 s on an idle machine.
const ATTACH_TIMEOUT_MS = 300_000;

const home = assertTrialHome();
const run = process.env.LOAD_RUN!;
const pid = Number(process.env.LOAD_HOST_PID);
const socketPath = join(home, "runtime", "host.sock");
const output = join(run, "probe.ndjson");
const relay = process.env.LOAD_RELAY === "1";
const paging = process.env.LOAD_PAGING === "1";
const attachId = process.env.LOAD_ATTACH_ID!;
const stopObserving = observeAttachments((event) => {
    if (event.state === "attached") log(output, { type: "attach_path", id: event.id,
        via: event.socketPath === undefined ? "unknown" : event.socketPath === socketPath ? "master" : "direct" });
});
let stopping = false;
const sampledReplacements = new Set<number>();
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
try { await Promise.all([
    periodic(500, async () => {
        const start = performance.now();
        const identity = await requestHostIdentity(socketPath);
        log(output, { type: "identity", ms: performance.now() - start, ok: identity !== undefined });
        // Keep a second connection open beyond the CLI deadline to measure late answers.
        const connection = await connectHost({ socketPath });
        const lateStart = performance.now();
        const startedAt = Date.now();
        try {
            await connection.send({ type: "host_identity" });
            const response = await connection.receiveWithin(10_000, "Identity response deadline") as { type: string };
            log(output, { type: "identity_uncapped", startedAt, ms: performance.now() - lateStart, ok: response.type === "host_identity" });
        } finally { connection.close(); }
    }),
    periodic(2000, async () => {
        const start = performance.now();
        const startedAt = Date.now();
        try {
            const agents = await listAgentsThroughHost(socketPath, 10_000);
            log(output, { type: "diagnostics", startedAt, ms: performance.now() - start, agents: agents.length,
                working: agents.filter((agent) => agent.status === "working").length,
                workers: new Set(agents.flatMap((agent) => agent.worker_pid === undefined ? [] : [agent.worker_pid])).size });
        } catch (error) {
            log(output, { type: "diagnostics_failed", startedAt, ms: performance.now() - start, error: String(error) });
            throw error;
        }
    }),
    periodic(10_000, async () => {
        const start = performance.now();
        const ready = await Bun.file(join(run, `resumed-${attachId}`)).json() as ReadyAgent;
        const client = relay
            ? await attachAgent({ socketPath, agentId: attachId, maxLineBytes: HISTORY_FRAME_BYTES,
                requestedCapabilities: paging ? PAGING_CAPABILITIES.filter((capability) => capability !== HOST_CAPABILITY_SESSION_ROUTING)
                    : [HOST_CAPABILITY_WORK_INDEX], signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS) })
            : await attachReconnectingAgent({ socketPath: () => socketPath, agentId: attachId, buildId: thisProcessBuildId(),
                failOnDisconnect: true, requestedCapabilities: paging ? PAGING_CAPABILITIES : CLIENT_CAPABILITIES,
                ...(ready.location === undefined ? {} : { initialLocation: ready.location }) });
        try {
            while ((await client.receive(AbortSignal.timeout(ATTACH_TIMEOUT_MS))).type !== "history") {}
            log(output, { type: "attach", ms: performance.now() - start });
        } finally { client.close(); }
    }),
    periodic(1000, async () => {
        const processes = await command(["/bin/ps", "-axo", "pid=,ppid=,command="]);
        const children = processes.split("\n").flatMap((line) => {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
            return match && Number(match[2]) === pid ? [{ pid: Number(match[1]), command: match[3] }] : [];
        });
        const hosts = await processReadings(pid, processes);
        const master = hosts.find((host) => host.pid === pid);
        log(output, { type: "process", cpu: master?.cpu, rssBytes: master?.rssBytes, children, hosts });
        const events = rows<{ type: string; pid?: number }>(join(home, "runtime", "logs", "host.jsonl"));
        for (const event of events) {
            if (event.type !== "session_process_replaced" || event.pid === undefined || sampledReplacements.has(event.pid)
                || !hosts.some((host) => host.pid === event.pid)) continue;
            sampledReplacements.add(event.pid);
            await sampleFootprints(run, pid, "replacement_ready");
        }
    }),
    periodic(10_000, async () => { await sampleFootprints(run, pid, "sample"); }),
]); } finally { stopObserving(); }
