import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resumeAgentThroughHost, type ReadyAgent, type ReadyAgentLocation } from "../../src/host/agent-start-client.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { HostConnectionClosedError } from "../../src/host/connection.ts";
import { CLIENT_CAPABILITIES, HOST_CAPABILITY_SESSION_ROUTING, HOST_CAPABILITY_WORK_INDEX } from "../../src/host/capabilities.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import type { HistoryUpdate } from "../../src/engine/protocol.ts";
import { assertTrialHome, hash, log, random, waitFor } from "./common.ts";
import { observeAttachments, type ObservedAttachment } from "./attachments.ts";
import type { KillPlan } from "./kill.ts";

const HISTORY_FRAME_BYTES = 256 * 1_024 * 1_024;
// Startup is not measured; three clients may load the giant histories at once.
const HISTORY_TIMEOUT_MS = 600_000;

const home = assertTrialHome();
const run = process.env.LOAD_RUN!;
const batch = process.env.LOAD_BATCH!;
const primary = process.env.LOAD_PRIMARY === "1";
const ids = JSON.parse(process.env.LOAD_IDS!) as string[];
const paging = process.env.LOAD_PAGING === "1";
const relay = process.env.LOAD_RELAY === "1";
const socketPath = join(home, "runtime", "host.sock");
const output = join(run, `client-${batch}.ndjson`);
const buildId = thisProcessBuildId();
const clientId = randomUUID();
const clients: AttachedAgentClient[] = [];
const attachments = new Map<string, ObservedAttachment>();
const stopObserving = observeAttachments((event) => {
    if (event.state === "attached") attachments.set(event.id, event);
    log(output, { type: event.state === "attached" ? "attach_path" : "attach_closed", id: event.id, batch,
        connection: event.connection, via: event.socketPath === undefined ? "unknown" : event.socketPath === socketPath ? "routed" : "direct",
        socketPath: event.socketPath ?? null, capabilities: event.capabilities, interactive: event.interactive });
});
let stopping = false;
const stop = () => { stopping = true; for (const client of clients) client.close(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function receiveHistory(client: AttachedAgentClient, deadline = Date.now() + HISTORY_TIMEOUT_MS): Promise<HistoryUpdate> {
    for (;;) {
        const update = await client.receive(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
        if (update.type === "history") return update;
    }
}

async function receiveAllHistory(client: AttachedAgentClient, id: string, deadline = Date.now() + HISTORY_TIMEOUT_MS): Promise<void> {
    const history = await receiveHistory(client, deadline);
    await receiveHistoryPages(client, history, id, deadline);
}

async function receiveHistoryPages(client: AttachedAgentClient, history: HistoryUpdate, id: string, deadline: number): Promise<void> {
    if (!paging) return;
    let page = history.page;
    let pages = 1;
    while (page?.hasMore === true && page.olderBefore !== undefined) {
        page = (await client.requestHistoryPage(page.olderBefore, AbortSignal.timeout(Math.max(1, deadline - Date.now())))).page;
        pages += 1;
    }
    log(output, { type: "paged", id, pages });
}

async function openClient(id: string, location?: ReadyAgentLocation, deadline = Date.now() + HISTORY_TIMEOUT_MS): Promise<AttachedAgentClient> {
    if (relay) {
        const capabilities = paging ? CLIENT_CAPABILITIES.filter((capability) => capability !== HOST_CAPABILITY_SESSION_ROUTING)
            : [HOST_CAPABILITY_WORK_INDEX];
        return await attachAgent({ socketPath, agentId: id, maxLineBytes: HISTORY_FRAME_BYTES,
            requestedCapabilities: capabilities, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    }
    return await attachReconnectingAgent({ socketPath: () => socketPath, agentId: id, buildId,
        interactive: true, clientId, failOnDisconnect: true, requestedCapabilities: CLIENT_CAPABILITIES,
        ...(location === undefined ? {} : { initialLocation: location }) });
}

async function session(id: string): Promise<void> {
    let client: AttachedAgentClient | undefined;
    try {
        if (primary) {
            const ready = await resumeAgentThroughHost(socketPath, join(home, "runtime", "sessions", `${id}.jsonl`));
            if (ready.id !== id) throw new Error(`Resume ${id} returned ${ready.id}`);
            const marker = join(run, `resumed-${id}`);
            await Bun.write(`${marker}.pending`, JSON.stringify(ready));
            await rename(`${marker}.pending`, marker);
        } else {
            await waitFor(() => existsSync(join(run, `resumed-${id}`)) || stopping, 180_000, `resume ${id}`);
        }
        if (stopping) return;
        const ready = await Bun.file(join(run, `resumed-${id}`)).json() as ReadyAgent;
        client = await openClient(id, ready.location);
        clients.push(client);
        await receiveAllHistory(client, id);
        let lastAttachment = attachments.get(id)?.connection;
        if (lastAttachment === undefined) throw new Error(`Could not observe the attachment for ${id}`);
        log(output, { type: "ready", id, primary });
        await waitFor(() => existsSync(join(run, "go.json")) || stopping, 300_000, "start barrier");
        if (stopping) return;
        const { end } = await Bun.file(join(run, "go.json")).json() as { end: number };
        const rng = random(Number(process.env.LOAD_SEED) ^ hash(id));
        let turn = 0;
        let primaryActive = primary;
        const prompt = async () => {
            log(output, { type: "prompt", id, turn });
            await client!.send({ type: "prompt", content: `LOAD_TURN:${id}:${turn++} Read the chart, adjust the pirate crow's record, and report.` });
        };
        if (primary) await prompt();
        while (!stopping && Date.now() < end) {
            try {
                const update = await client.receive(AbortSignal.timeout(Math.max(1, end - Date.now())));
                const attachment = attachments.get(id);
                if (!relay && attachment !== undefined && attachment.connection !== lastAttachment) {
                    lastAttachment = attachment.connection;
                    const killPath = join(run, "kill.json");
                    const plan = existsSync(killPath) ? await Bun.file(killPath).json() as KillPlan : undefined;
                    if (plan?.sessions.includes(id)) {
                        if (update.type === "history") await receiveHistoryPages(client, update, id, end);
                        primaryActive = false;
                        log(output, { type: "reattached", id, batch, worker: plan.worker });
                    }
                }
                if (update.type === "ui_request") throw new Error(`Unexpected UI request: ${JSON.stringify(update.request)}`);
                if (update.type === "agent_failed" || update.type === "prompt_rejected") throw new Error(JSON.stringify(update));
                if (update.type === "turn_finished" && primaryActive) {
                    log(output, { type: "turn", id, outcome: update.outcome ?? "ok", error: update.error });
                    if (update.outcome) throw new Error(`Turn ${update.outcome}: ${update.error ?? ""}`);
                    await Bun.sleep(1000 + rng() * 4000);
                    if (Date.now() < end && !stopping) await prompt();
                }
            } catch (error) {
                const killPath = join(run, "kill.json");
                const plan = existsSync(killPath) ? await Bun.file(killPath).json() as KillPlan : undefined;
                const disconnected = error instanceof HostConnectionClosedError || (error instanceof Error
                    && (error.message === "host connection is closed" || error.message === "host connection received an incomplete line"));
                if (!disconnected || plan === undefined || !plan.sessions.includes(id) || Date.now() >= end) throw error;
                log(output, { type: "disconnected", id, error: error instanceof Error ? error.message : String(error) });
                client.close();
                let replacement: AttachedAgentClient | undefined;
                while (!stopping && Date.now() < end) {
                    try {
                        replacement = await openClient(id, undefined, end);
                        await receiveAllHistory(replacement, id, end);
                        break;
                    } catch {
                        replacement?.close();
                        replacement = undefined;
                        await Bun.sleep(100);
                    }
                }
                if (replacement === undefined) throw new Error(`Could not reattach ${id} after worker loss`);
                client = replacement;
                clients.push(client);
                lastAttachment = attachments.get(id)?.connection;
                primaryActive = false;
                log(output, { type: "reattached", id, batch, worker: plan.worker });
            }
        }
    } catch (error) {
        const ended = existsSync(join(run, "go.json")) && Date.now() >= (await Bun.file(join(run, "go.json")).json()).end - 250;
        if (!stopping && !ended) log(output, { type: "error", id, error: error instanceof Error ? error.stack || String(error) : String(error) });
    } finally { client?.close(); }
}

try {
    await waitFor(() => existsSync(socketPath), 120_000, "host socket");
    await Promise.all(ids.map(session));
    log(output, { type: "exit", batch });
} finally { stopObserving(); }
