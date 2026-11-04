import { existsSync } from "node:fs";
import { join } from "node:path";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { connectHost } from "../../src/host/connection.ts";
import { HOST_CAPABILITY_WORK_INDEX } from "../../src/host/capabilities.ts";
import { assertTrialHome, hash, log, random, waitFor } from "./common.ts";

// The fixture's largest session attaches as a 78.9 MB history frame.
const HISTORY_FRAME_BYTES = 256 * 1_024 * 1_024;
// Startup is not measured; three clients may load the giant histories at once.
const HISTORY_TIMEOUT_MS = 600_000;

const home = assertTrialHome();
const run = process.env.LOAD_RUN!;
const batch = process.env.LOAD_BATCH!;
const primary = process.env.LOAD_PRIMARY === "1";
const ids = JSON.parse(process.env.LOAD_IDS!) as string[];
const socketPath = join(home, "runtime", "host.sock");
const output = join(run, `client-${batch}.ndjson`);
const clients: AttachedAgentClient[] = [];
let stopping = false;
const stop = () => { stopping = true; for (const client of clients) client.close(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function session(id: string): Promise<void> {
    let client: AttachedAgentClient | undefined;
    try {
        if (primary) {
            const connection = await connectHost({ socketPath });
            try {
                await connection.send({ type: "resume_agent", session_path: join(home, "runtime", "sessions", `${id}.jsonl`) });
                const response = await connection.receiveWithin(120_000, "Resume deadline") as { type: string; reason?: string };
                if (response.type !== "agent_ready") throw new Error(`Resume ${id}: ${JSON.stringify(response)}`);
            } finally { connection.close(); }
            await Bun.write(join(run, `resumed-${id}`), "ready");
        } else {
            await waitFor(() => existsSync(join(run, `resumed-${id}`)) || stopping, 180_000, `resume ${id}`);
        }
        if (stopping) return;
        client = await attachAgent({ socketPath, agentId: id, maxLineBytes: HISTORY_FRAME_BYTES, requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX], signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) });
        clients.push(client);
        while ((await client.receive(AbortSignal.timeout(HISTORY_TIMEOUT_MS))).type !== "history") {}
        log(output, { type: "ready", id, primary });
        await waitFor(() => existsSync(join(run, "go.json")) || stopping, 300_000, "start barrier");
        if (stopping) return;
        const { end } = await Bun.file(join(run, "go.json")).json() as { end: number };
        const rng = random(Number(process.env.LOAD_SEED) ^ hash(id));
        let turn = 0;
        const prompt = async () => {
            log(output, { type: "prompt", id, turn });
            await client!.send({ type: "prompt", content: `LOAD_TURN:${id}:${turn++} Read the chart, adjust the pirate crow's record, and report.` });
        };
        if (primary) await prompt();
        while (!stopping && Date.now() < end) {
            const update = await client.receive(AbortSignal.timeout(Math.max(1, end - Date.now())));
            if (update.type === "ui_request") throw new Error(`Unexpected UI request: ${JSON.stringify(update.request)}`);
            if (update.type === "agent_failed" || update.type === "prompt_rejected") throw new Error(JSON.stringify(update));
            if (update.type === "turn_finished" && primary) {
                log(output, { type: "turn", id, outcome: update.outcome ?? "ok", error: update.error });
                if (update.outcome) throw new Error(`Turn ${update.outcome}: ${update.error ?? ""}`);
                await Bun.sleep(1000 + rng() * 4000);
                if (Date.now() < end && !stopping) await prompt();
            }
        }
    } catch (error) {
        const ended = existsSync(join(run, "go.json")) && Date.now() >= (await Bun.file(join(run, "go.json")).json()).end - 250;
        if (!stopping && !ended) log(output, { type: "error", id, error: error instanceof Error ? error.stack || String(error) : String(error) });
    } finally { client?.close(); }
}

await waitFor(() => existsSync(socketPath), 120_000, "host socket");
await Promise.all(ids.map(session));
log(output, { type: "exit", batch });
