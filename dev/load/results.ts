import { readdirSync } from "node:fs";
import { join } from "node:path";
import { rows, summary } from "./common.ts";

interface Sample {
    at: number;
    type: string;
    ms?: number;
    delayMs?: number;
    cpu?: number;
    rssBytes?: number;
    workers?: number;
    working?: number;
    tokens?: number;
    ok?: boolean;
    outcome?: string;
    children?: { pid: number; command: string }[];
    error?: string;
}
export interface Scenario { sessions: number; clients: number; duration: number; extensions: "included" | "none"; seed: number; small: boolean; paging?: boolean; }
export interface Footprint { bytes: number | null; path: string; error?: string; }

export function collectResult(run: string, scenario: Scenario, start: number, end: number, sha: string, footprint: { start: Footprint; end: Footprint }, errors: string[]) {
    const window = (sample: Sample) => sample.at >= start && sample.at <= end;
    const probe = rows<Sample>(join(run, "probe.ndjson")).filter(window);
    const drift = rows<Sample>(join(run, "drift.ndjson")).filter(window);
    const provider = rows<Sample>(join(run, "provider.ndjson")).filter(window);
    const clients = readdirSync(run).filter((file) => /^client-.*\.ndjson$/.test(file)).flatMap((file) => rows<Sample>(join(run, file)));
    const latencies = (type: string) => summary(probe.filter((row) => row.type === type && row.ms !== undefined).map((row) => row.ms!));
    const processes = probe.filter((row) => row.type === "process");
    const rss = processes.map((row) => row.rssBytes!);
    const seconds = (end - start) / 1000;
    const requests = provider.filter((row) => row.type === "request").length;
    const turns = clients.filter((row) => window(row) && row.type === "turn" && row.outcome === "ok").length;
    const streamedTokens = provider.reduce((total, row) => total + (row.type === "tokens" ? row.tokens ?? 0 : 0), 0);
    return {
        schemaVersion: 1, gitSha: sha, scenario, run, start, end, measuredSeconds: seconds,
        rates: { modelRequests: requests, turns, streamedTokens, modelRequestsPerSecond: requests / seconds, turnsPerSecond: turns / seconds, streamedTokensPerSecond: streamedTokens / seconds },
        hostCpuPercent: summary(processes.map((row) => row.cpu!)),
        hostRssBytes: { start: rss[0] ?? null, peak: rss.length ? Math.max(...rss) : null, end: rss.at(-1) ?? null },
        footprint,
        eventLoopDelayMs: summary(drift.map((row) => row.delayMs!)),
        identityLatencyMs: latencies("identity"),
        identityUncappedLatencyMs: latencies("identity_uncapped"),
        identityMisses: probe.filter((row) => row.type === "identity" && row.ok === false).length,
        diagnosticsLatencyMs: latencies("diagnostics"),
        attachLatencyMs: latencies("attach"),
        workerCount: summary(probe.filter((row) => row.type === "diagnostics").map((row) => row.workers!)),
        hostChildProcessCount: summary(processes.map((row) => row.children?.length ?? 0)),
        workingSessions: summary(probe.filter((row) => row.type === "diagnostics").map((row) => row.working!)),
        readyClients: clients.filter((row) => row.type === "ready").length,
        missedProbeTicks: probe.filter((row) => row.type === "missed_tick").length,
        errors: [...errors, ...[...clients, ...probe, ...provider].filter((row) => row.type === "error").map((row) => row.error ?? "Unknown error")],
    };
}
export type Result = ReturnType<typeof collectResult>;
export function checkFailed(result: Result): boolean {
    return result.errors.length > 0 || (result.scenario.sessions === 100 && (
        result.identityMisses > 0 || (result.identityLatencyMs.max ?? Infinity) >= 100
        || (result.identityUncappedLatencyMs.max ?? Infinity) >= 100
        || (result.eventLoopDelayMs.max ?? Infinity) > 250
    ));
}
export function table(results: Result[]): string {
    const n = (value: number | null, digits = 1) => value === null ? "n/a" : value.toFixed(digits);
    return [
        "| Sessions | Clients/session | Req/s | Turns/s | Tokens/s | CPU mean/p90 % | RSS peak MB | Loop p99/max ms | Identity p90/max ms | Misses | Diagnostics p90 ms | Attach p90 ms | Workers max | Errors |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ...results.map((r) => `| ${r.scenario.sessions} | ${r.scenario.clients} | ${n(r.rates.modelRequestsPerSecond, 2)} | ${n(r.rates.turnsPerSecond, 2)} | ${n(r.rates.streamedTokensPerSecond)} | ${n(r.hostCpuPercent.mean)}/${n(r.hostCpuPercent.p90)} | ${n(r.hostRssBytes.peak === null ? null : r.hostRssBytes.peak / 1e6)} | ${n(r.eventLoopDelayMs.p99)}/${n(r.eventLoopDelayMs.max)} | ${n(r.identityUncappedLatencyMs.p90)}/${n(r.identityUncappedLatencyMs.max)} | ${r.identityMisses} | ${n(r.diagnosticsLatencyMs.p90)} | ${n(r.attachLatencyMs.p90)} | ${n(r.workerCount.max, 0)} | ${r.errors.length} |`),
    ].join("\n") + "\n";
}
