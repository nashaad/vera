import { join } from "node:path";
import { command, log } from "./common.ts";

export interface ProcessReading {
    readonly pid: number;
    readonly role: string;
    readonly cpu: number | null;
    readonly rssBytes: number | null;
}

export interface ProcessFootprint {
    readonly pid: number;
    readonly role: string;
    readonly bytes: number | null;
    readonly path?: string;
    readonly error?: string;
}

export async function processReadings(hostPid: number, existingTable?: string): Promise<ProcessReading[]> {
    const table = existingTable ?? await command(["/bin/ps", "-axo", "pid=,ppid=,command="]);
    const entries = table.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match === null ? [] : [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }];
    });
    const hosts = [{ pid: hostPid, role: "host" }];
    let changed = true;
    while (changed) {
        changed = false;
        for (const entry of entries) {
            if (hosts.some((host) => host.pid === entry.pid) || !hosts.some((host) => host.pid === entry.parent)) continue;
            const index = /--worker-index\s+(\d+)/.exec(entry.command);
            const generation = /--worker-generation\s+(\d+)/.exec(entry.command);
            const role = index !== null && generation !== null ? `w${index[1]}-g${generation[1]}`
                : entry.command.includes("src/host/worker-supervisor.ts") ? `turn-supervisor-${entry.pid}`
                : entry.command.includes("src/host/worker/entry.ts") ? `turn-worker-${entry.pid}` : undefined;
            if (role === undefined) continue;
            hosts.push({ pid: entry.pid, role });
            changed = true;
        }
    }
    const output = await command(["/bin/ps", "-p", hosts.map((host) => host.pid).join(","), "-o", "pid=,%cpu=,rss="]);
    const metrics = new Map(output.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line);
        return match === null ? [] : [[Number(match[1]), { cpu: Number(match[2]), rssBytes: Number(match[3]) * 1_024 }] as const];
    }));
    return hosts.map((host) => ({ ...host, cpu: metrics.get(host.pid)?.cpu ?? null, rssBytes: metrics.get(host.pid)?.rssBytes ?? null }));
}

export async function sampleFootprints(run: string, hostPid: number, phase: "host_ready" | "ready" | "replacement_ready" | "sample" | "end"): Promise<ProcessFootprint[]> {
    const processes = await processReadings(hostPid);
    const samples = await Promise.all(processes.map(async (process): Promise<ProcessFootprint> => {
        const path = phase === "sample" ? undefined : join(run, `footprint-${phase}-${process.pid}.txt`);
        try {
            const output = await command(["/usr/bin/footprint", "-p", String(process.pid)]);
            const match = /(?:Physical footprint|Footprint):\s*([\d.]+)\s*([KMGT]?)B/i.exec(output);
            const multipliers: Record<string, number> = { "": 1, K: 1_024, M: 1_024 ** 2, G: 1_024 ** 3, T: 1_024 ** 4 };
            const bytes = match === null ? null : Number(match[1]) * (multipliers[match[2]!.toUpperCase()] ?? 1);
            if (path !== undefined) await Bun.write(path, output);
            return { pid: process.pid, role: process.role, bytes, ...(path === undefined ? {} : { path }),
                ...(bytes === null ? { error: "Footprint output has no physical-footprint field" } : {}) };
        } catch (error) {
            if (path !== undefined) await Bun.write(path, String(error));
            return { pid: process.pid, role: process.role, bytes: null, ...(path === undefined ? {} : { path }), error: String(error) };
        }
    }));
    log(join(run, "footprints.ndjson"), { type: "footprint", phase, processes: samples });
    return samples;
}
