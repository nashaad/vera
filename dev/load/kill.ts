import { existsSync, readdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { connectHost } from "../../src/host/connection.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { WORKER_EXIT_TURN_MESSAGE } from "../../src/store/session-store.ts";
import { rows, waitFor } from "./common.ts";
import type { ProcessOwner } from "./processes.ts";

export interface WorkerLocation {
    readonly id: string;
    readonly worker: string;
    readonly socket: string;
}

export interface KillPlan {
    readonly at: number;
    readonly pid: number;
    readonly worker: string;
    readonly target: string;
    readonly turn: string;
    readonly sessions: readonly string[];
    readonly beforeRecords: number;
}

interface ClientSample { readonly at: number; readonly id?: string; readonly type: string; }
interface ProviderSample { readonly at: number; readonly key?: string; readonly type: string; }

export async function workerLocations(home: string, ids: readonly string[]): Promise<WorkerLocation[]> {
    const socket = join(home, "runtime", "host.sock");
    const locations: WorkerLocation[] = [];
    for (const id of ids) {
        const connection = await connectHost({ socketPath: socket });
        try {
            await connection.send({ type: "locate_agent", agent_id: id });
            const value = await connection.receiveWithin(10_000, "Location deadline") as Record<string, unknown>;
            if (value.type !== "agent_location" || typeof value.worker_id !== "string"
                || value.worker_id === "host" || typeof value.socket_path !== "string") {
                throw new Error(`Could not locate ${id} on a session process`);
            }
            locations.push({ id, worker: value.worker_id, socket: value.socket_path });
        } finally { connection.close(); }
    }
    return locations;
}

export async function killActiveWorker(run: string, home: string, owner: ProcessOwner, locations: readonly WorkerLocation[]): Promise<KillPlan> {
    const provider = join(run, "provider.ndjson");
    let selected: { key: string; location: WorkerLocation } | undefined;
    await waitFor(() => {
        const clients = readdirSync(run).filter((name) => /^client-0-.*\.ndjson$/.test(name))
            .flatMap((name) => rows<ClientSample>(join(run, name)));
        const requests = rows<ProviderSample>(provider).filter((row) => row.type === "request" && row.key !== undefined);
        for (const request of requests.toReversed()) {
            const id = request.key!.split(":")[0]!;
            const location = locations.find((entry) => entry.id === id);
            if (location === undefined) continue;
            const lastTurn = clients.filter((row) => row.id === id && row.type === "turn").at(-1);
            if (lastTurn !== undefined && lastTurn.at >= request.at) continue;
            selected = { key: request.key!, location };
            return true;
        }
        return false;
    }, 30_000, "running turn for worker kill");
    const target = selected!;
    const identity = await requestHostIdentity(target.location.socket);
    if (identity?.role !== "worker" || identity.worker_id !== target.location.worker) throw new Error("Worker identity is unavailable");
    const path = join(home, "runtime", "sessions", `${target.location.id}.jsonl`);
    const beforeRecords = (await Bun.file(path).text()).split(WORKER_EXIT_TURN_MESSAGE).length - 1;
    const plan: KillPlan = { at: Date.now(), pid: identity.pid, worker: target.location.worker, target: target.location.id,
        turn: target.key, sessions: locations.filter((entry) => entry.worker === target.location.worker).map((entry) => entry.id), beforeRecords };
    const temporary = join(run, "kill.pending");
    await Bun.write(temporary, JSON.stringify(plan));
    await rename(temporary, join(run, "kill.json"));
    await owner.killWorker(identity.pid);
    return plan;
}

export async function failedTurnRecords(home: string, plan: KillPlan): Promise<number | null> {
    const path = join(home, "runtime", "sessions", `${plan.target}.jsonl`);
    if (!existsSync(path)) return null;
    return (await Bun.file(path).text()).split(WORKER_EXIT_TURN_MESSAGE).length - 1 - plan.beforeRecords;
}
