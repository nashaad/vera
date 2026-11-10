import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rows, summary } from "./common.ts";
import type { ProcessFootprint, ProcessReading } from "./metrics.ts";
import type { StopMeasurement } from "./processes.ts";
import type { KillPlan } from "./kill.ts";

interface Sample {
    at: number;
    startedAt?: number;
    type: string;
    id?: string;
    batch?: string;
    connection?: number;
    via?: "direct" | "routed" | "unknown";
    ms?: number;
    delayMs?: number;
    cpu?: number;
    rssBytes?: number;
    workers?: number;
    working?: number;
    tokens?: number;
    markerLost?: boolean;
    ok?: boolean;
    outcome?: string;
    children?: { pid: number; command: string }[];
    hosts?: ProcessReading[];
    error?: string;
}
interface FootprintSample {
    readonly at: number;
    readonly type: string;
    readonly phase: "host_ready" | "ready" | "replacement_ready" | "sample" | "end";
    readonly processes: readonly ProcessFootprint[];
}
interface PinSample { readonly at: number; readonly pid: number; readonly worker: number; readonly type: string; readonly iterations?: number; readonly error?: string; }
interface PinOwner { readonly id: string; readonly worker: string; }
interface WorkerLoss {
    readonly timestamp: string;
    readonly type: string;
    readonly pid: number;
    readonly reason: string;
    readonly exit_code: number | null;
    readonly signal: string | null;
}
export interface Scenario { sessions: number; clients: number; duration: number; extensions: "included" | "none"; seed: number; small: boolean; paging?: boolean; relay?: boolean; workers?: number; pinWorker?: boolean; killWorker?: boolean; }
export interface Footprint { bytes: number | null; path: string; error?: string; }

export function collectResult(run: string, scenario: Scenario, start: number, end: number, sha: string, footprint: { start: Footprint; end: Footprint }, errors: string[], stop?: StopMeasurement, kill?: KillPlan, failedRecords: number | null = null) {
    const window = (sample: Sample) => sample.at >= start && sample.at <= end;
    const allProbe = rows<Sample>(join(run, "probe.ndjson"));
    const probe = allProbe.filter(window);
    const drift = rows<Sample>(join(run, "drift.ndjson")).filter(window);
    const workerDrift = readdirSync(run).flatMap((file) => {
        const match = /^drift-worker-(\d+)\.ndjson$/.exec(file);
        if (match === null) return [];
        const samples = rows<Sample>(join(run, file)).filter(window).flatMap((row) => row.delayMs === undefined ? [] : [row.delayMs]);
        return [{ pid: Number(match[1]), delayMs: summary(samples) }];
    });
    const provider = rows<Sample>(join(run, "provider.ndjson")).filter(window);
    const pinSamples = rows<PinSample>(join(run, "pin.ndjson"));
    const pin = pinSamples.find((sample) => sample.type === "start");
    const pinEnd = pin === undefined ? undefined : pinSamples.find((sample) => sample.type === "end" && sample.pid === pin.pid);
    const pinLoss = pin === undefined ? undefined : rows<WorkerLoss>(join(run, "home", "runtime", "logs", "host.jsonl"))
        .find((event) => event.type === "session_process_lost" && event.pid === pin.pid && Date.parse(event.timestamp) >= pin.at);
    const pinUntil = Math.min(end, pinEnd?.at ?? (pinLoss === undefined ? end : Date.parse(pinLoss.timestamp)));
    const duringPin = (sample: Sample): boolean => {
        const startedAt = sample.startedAt ?? sample.at - (sample.ms ?? 0);
        return pin !== undefined && startedAt >= pin.at && startedAt <= pinUntil;
    };
    const pinOwnersPath = join(run, "pin-owners.ndjson");
    const pinSessions = pin === undefined ? [] : rows<PinOwner>(pinOwnersPath)
        .filter((owner) => owner.worker === `w${pin.worker}`).map((owner) => owner.id);
    const clients = readdirSync(run).flatMap((file) => {
        const match = /^client-(.*)\.ndjson$/.exec(file);
        return match === null ? [] : rows<Sample>(join(run, file)).map((row) => ({ ...row, batch: row.batch ?? match[1] }));
    });
    const lastAttachments = new Map<string, Sample>();
    for (const sample of clients.filter((row) => row.type === "attach_path" && row.at <= end).toSorted((a, b) => a.at - b.at)) {
        if (sample.id !== undefined && sample.batch !== undefined) lastAttachments.set(`${sample.batch}/${sample.id}`, sample);
    }
    const attachmentCounts = { direct: 0, routed: 0, unknown: Math.max(0, scenario.sessions * scenario.clients - lastAttachments.size) };
    for (const sample of lastAttachments.values()) {
        if (sample.via === "direct") attachmentCounts.direct += 1;
        else if (sample.via === "routed") attachmentCounts.routed += 1;
        else attachmentCounts.unknown += 1;
    }
    const pinErrors = clients.filter((row) => window(row) && row.type === "error" && row.id !== undefined);
    const pinOwnedErrors = pinErrors.filter((row) => pinSessions.includes(row.id!));
    const pinOtherErrors = pinErrors.filter((row) => !pinSessions.includes(row.id!));
    const signals = rows<{ readonly at: number; readonly pid?: number; readonly type: string; readonly signal?: string }>(join(run, "pids.ndjson"));
    const signalAt = kill === undefined ? undefined : signals.find((row) => row.type === "signal" && row.pid === kill.pid
        && row.signal === "SIGKILL" && row.at >= kill.at)?.at;
    const reattached = kill === undefined ? [] : clients.filter((row) => row.type === "reattached" && row.id !== undefined && row.batch !== undefined
        && kill.sessions.includes(row.id));
    const attachedClients = new Set(reattached.map((row) => `${row.batch}/${row.id}`));
    const expectedReattachments = kill === undefined ? 0 : kill.sessions.length * scenario.clients;
    const otherErrors = kill === undefined ? [] : clients.filter((row) => row.type === "error" && row.id !== undefined && !kill.sessions.includes(row.id));
    const latencies = (type: string) => summary(probe.filter((row) => row.type === type && row.ms !== undefined).map((row) => row.ms!));
    const processes = probe.filter((row) => row.type === "process");
    const rss = processes.map((row) => row.rssBytes!);
    const totals = processes.flatMap((row) => {
        if (row.hosts === undefined || row.hosts.some((host) => host.cpu === null || host.rssBytes === null)) return [];
        return [{ cpu: row.hosts.reduce((sum, host) => sum + host.cpu!, 0), rss: row.hosts.reduce((sum, host) => sum + host.rssBytes!, 0) }];
    });
    const footprintSamples = rows<FootprintSample>(join(run, "footprints.ndjson"))
        .filter((sample) => (sample.phase !== "sample" && sample.phase !== "replacement_ready") || window(sample));
    const footprintPids = [...new Set(footprintSamples.flatMap((sample) => sample.processes.map((process) => process.pid)))];
    const physicalProcesses = footprintPids.map((pid) => {
        const found = footprintSamples.flatMap((sample) => sample.processes.filter((process) => process.pid === pid)
            .map((process) => ({ phase: sample.phase, ...process })));
        const values = found.flatMap((process) => process.bytes === null ? [] : [process.bytes]);
        return { pid, role: found[0]!.role, hostReady: found.find((process) => process.phase === "host_ready")?.bytes ?? null,
            ready: found.find((process) => process.phase === "ready" || process.phase === "replacement_ready")?.bytes ?? null,
            peak: values.length === 0 ? null : Math.max(...values), end: found.findLast((process) => process.phase === "end")?.bytes ?? null,
            errors: found.flatMap((process) => process.error === undefined ? [] : [process.error]) };
    });
    const physicalTotals = footprintSamples.map((sample) => ({ phase: sample.phase,
        bytes: sample.processes.length === 0 || sample.processes.some((process) => process.bytes === null)
            ? null : sample.processes.reduce((sum, process) => sum + process.bytes!, 0) }));
    const physicalValues = physicalTotals.flatMap((sample) => sample.bytes === null ? [] : [sample.bytes]);
    const seconds = (end - start) / 1000;
    const requests = provider.filter((row) => row.type === "request").length;
    const markerLostRequests = provider.filter((row) => row.type === "request" && row.markerLost === true).length;
    const turns = clients.filter((row) => window(row) && row.type === "turn" && row.outcome === "ok").length;
    const streamedTokens = provider.reduce((total, row) => total + (row.type === "tokens" ? row.tokens ?? 0 : 0), 0);
    const measurementErrors: string[] = [];
    if (clients.filter((row) => row.type === "ready").length === scenario.sessions * scenario.clients && attachmentCounts.unknown > 0) {
        measurementErrors.push(`Unobserved attachment paths: ${attachmentCounts.unknown}`);
    }
    if (scenario.relay === true && attachmentCounts.direct > 0) measurementErrors.push("Relay clients attached directly");
    measurementErrors.push(...pinSamples.filter((sample) => sample.type === "error").map((sample) => `Pin: ${sample.error ?? "Unknown error"}`));
    if (scenario.pinWorker === true && pin === undefined) measurementErrors.push("Pinned session process did not start");
    if (pin !== undefined && !existsSync(pinOwnersPath)) measurementErrors.push("Pinned session ownership was not recorded");
    if (pin !== undefined && pinLoss === undefined && (pinEnd === undefined || pinEnd.at < end - 1_000)) {
        measurementErrors.push("Pinned session process did not run for the full window");
    }
    if (scenario.killWorker === true && kill === undefined) measurementErrors.push("No session process was killed");
    if (kill !== undefined && attachedClients.size < expectedReattachments) {
        measurementErrors.push(`Reattached ${attachedClients.size} of ${expectedReattachments} affected clients`);
    }
    if (kill !== undefined && failedRecords !== 1) measurementErrors.push(`Failed-turn records: ${failedRecords}`);
    return {
        schemaVersion: 1, gitSha: sha, scenario, run, start, end, measuredSeconds: seconds,
        attachments: { path: scenario.relay === true ? "relay" : "routed", ...attachmentCounts },
        rates: { modelRequests: requests, markerLostRequests, turns, streamedTokens, modelRequestsPerSecond: requests / seconds, turnsPerSecond: turns / seconds, streamedTokensPerSecond: streamedTokens / seconds },
        hostCpuPercent: summary(processes.map((row) => row.cpu!)),
        hostRssBytes: { start: rss[0] ?? null, peak: rss.length ? Math.max(...rss) : null, end: rss.at(-1) ?? null },
        totalCpuPercent: summary(totals.map((sample) => sample.cpu)),
        totalRssBytes: { peak: totals.length === 0 ? null : Math.max(...totals.map((sample) => sample.rss)) },
        footprint,
        physicalFootprint: { processes: physicalProcesses,
            hostReady: physicalTotals.find((sample) => sample.phase === "host_ready")?.bytes ?? null,
            ready: physicalTotals.find((sample) => sample.phase === "ready")?.bytes ?? null,
            peak: physicalValues.length === 0 ? null : Math.max(...physicalValues),
            end: physicalTotals.findLast((sample) => sample.phase === "end")?.bytes ?? null },
        stop: stop ?? null,
        kill: kill === undefined ? null : { ...kill, signalAt: signalAt ?? null, failedRecords,
            expectedClients: expectedReattachments, reattachedClients: attachedClients.size,
            reattachMs: signalAt === undefined || attachedClients.size < expectedReattachments ? null
                : Math.max(...reattached.map((sample) => sample.at)) - signalAt,
            otherErrors: otherErrors.length, otherErrorSessions: [...new Set(otherErrors.flatMap((row) => row.id === undefined ? [] : [row.id]))] },
        pin: pin === undefined ? null : { pid: pin.pid, worker: pin.worker, start: pin.at, end: pinEnd?.at ?? null, iterations: pinEnd?.iterations ?? null,
            sessions: pinSessions, loss: pinLoss ?? null,
            ownedErrors: pinOwnedErrors.length, ownedErrorSessions: [...new Set(pinOwnedErrors.map((row) => row.id!))],
            otherErrors: pinOtherErrors.length, otherErrorSessions: [...new Set(pinOtherErrors.map((row) => row.id!))],
            eventLoopDelayMs: workerDrift.find((worker) => worker.pid === pin.pid)?.delayMs ?? summary([]),
            cpuPercent: summary(processes.filter((sample) => sample.at >= pin.at && sample.at <= pinUntil).flatMap((sample) => sample.hosts?.filter((host) => host.pid === pin.pid && host.cpu !== null)
                .map((host) => host.cpu!) ?? [])),
            identityLatencyMs: summary(allProbe.filter((sample) => sample.type === "identity_uncapped" && duringPin(sample) && sample.ms !== undefined)
                .map((sample) => sample.ms!)),
            agentListLatencyMs: summary(allProbe.filter((sample) => (sample.type === "diagnostics" || sample.type === "diagnostics_failed")
                && duringPin(sample) && sample.ms !== undefined).map((sample) => sample.ms!)),
            agentListFailures: allProbe.filter((sample) => sample.type === "diagnostics_failed" && duringPin(sample)).length },
        eventLoopDelayMs: summary(drift.map((row) => row.delayMs!)),
        workerEventLoopDelayMs: {
            processes: workerDrift,
            p99: workerDrift.reduce<number | null>((worst, worker) => worker.delayMs.p99 === null ? worst : Math.max(worst ?? 0, worker.delayMs.p99), null),
            max: workerDrift.reduce<number | null>((worst, worker) => worker.delayMs.max === null ? worst : Math.max(worst ?? 0, worker.delayMs.max), null),
        },
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
        errors: [...errors, ...measurementErrors, ...[...clients, ...probe, ...provider].filter((row) => row.type === "error").map((row) => row.error ?? "Unknown error")],
    };
}
export type Result = ReturnType<typeof collectResult>;
export function footprintDetails(result: Result): string {
    const mb = (value: number | null): string => value === null ? "n/a" : (value / 1e6).toFixed(1);
    return [
        "Physical footprint MB (host-ready/ready/peak/end):",
        ...result.physicalFootprint.processes.map((process) =>
            `${process.role} (PID ${process.pid}): ${mb(process.hostReady)}/${mb(process.ready)}/${mb(process.peak)}/${mb(process.end)}`),
        `sum: ${mb(result.physicalFootprint.hostReady)}/${mb(result.physicalFootprint.ready)}/${mb(result.physicalFootprint.peak)}/${mb(result.physicalFootprint.end)}`,
    ].join("\n") + "\n";
}
export function checkFailed(result: Result): boolean {
    return result.errors.length > 0 || (result.scenario.sessions === 100 && (
        result.identityMisses > 0 || (result.identityLatencyMs.max ?? Infinity) >= 100
        || (result.identityUncappedLatencyMs.max ?? Infinity) >= 100
        || (result.eventLoopDelayMs.max ?? Infinity) > 250
    ));
}
export function table(results: Result[]): string {
    const n = (value: number | null, digits = 1) => value === null ? "n/a" : value.toFixed(digits);
    const headings = ["Mode", "Attach path", "Direct", "Routed", "Unknown", "Sessions", "Clients/session", "Req/s", "Marker lost", "Turns/s", "Tokens/s", "CPU mean/p90 %", "Total CPU mean/p90 %",
        "RSS peak MB", "Sum RSS peak MB", "Footprint ready/peak/end MB", "Loop p99/max ms", "Worker loop worst p99/max ms",
        "Identity p90/max ms", "Misses", "Diagnostics p90 ms", "Attach p90 ms", "Workers max", "Pin CPU mean/p90 %",
        "Pin identity p90/max ms", "Pin loop p99/max ms", "Pin agent list p90/max ms", "Pin list failures", "Pin errors owned/other", "Pin loss",
        "Kill reattach ms", "Kill records", "Other errors", "Stop wall ms", "Stop awake ms", "Records left", "Errors"];
    return [
        `| ${headings.join(" | ")} |`,
        `|${headings.map(() => "---:").join("|")}|`,
        ...results.map((r) => {
            const mode = r.scenario.workers === 0 ? "single"
                : r.scenario.pinWorker ? "pool pin" : r.scenario.killWorker ? "pool kill" : "pool";
            const mb = (value: number | null): string => n(value === null ? null : value / 1e6);
            const values = [
                mode, r.attachments.path, r.attachments.direct, r.attachments.routed, r.attachments.unknown,
                r.scenario.sessions, r.scenario.clients, n(r.rates.modelRequestsPerSecond, 2), r.rates.markerLostRequests,
                n(r.rates.turnsPerSecond, 2), n(r.rates.streamedTokensPerSecond),
                `${n(r.hostCpuPercent.mean)}/${n(r.hostCpuPercent.p90)}`,
                `${n(r.totalCpuPercent.mean)}/${n(r.totalCpuPercent.p90)}`,
                mb(r.hostRssBytes.peak), mb(r.totalRssBytes.peak),
                `${mb(r.physicalFootprint.ready)}/${mb(r.physicalFootprint.peak)}/${mb(r.physicalFootprint.end)}`,
                `${n(r.eventLoopDelayMs.p99)}/${n(r.eventLoopDelayMs.max)}`,
                `${n(r.workerEventLoopDelayMs.p99)}/${n(r.workerEventLoopDelayMs.max)}`,
                `${n(r.identityUncappedLatencyMs.p90)}/${n(r.identityUncappedLatencyMs.max)}`,
                r.identityMisses, n(r.diagnosticsLatencyMs.p90), n(r.attachLatencyMs.p90), n(r.workerCount.max, 0),
                `${n(r.pin?.cpuPercent.mean ?? null)}/${n(r.pin?.cpuPercent.p90 ?? null)}`,
                `${n(r.pin?.identityLatencyMs.p90 ?? null)}/${n(r.pin?.identityLatencyMs.max ?? null)}`,
                `${n(r.pin?.eventLoopDelayMs.p99 ?? null)}/${n(r.pin?.eventLoopDelayMs.max ?? null)}`,
                `${n(r.pin?.agentListLatencyMs.p90 ?? null)}/${n(r.pin?.agentListLatencyMs.max ?? null)}`,
                r.pin?.agentListFailures ?? "n/a", r.pin === null ? "n/a" : `${r.pin.ownedErrors}/${r.pin.otherErrors}`,
                r.pin === null ? "n/a" : r.pin.loss?.reason ?? "none", n(r.kill?.reattachMs ?? null),
                r.kill?.failedRecords ?? "n/a", r.kill?.otherErrors ?? "n/a", n(r.stop?.elapsedMs ?? null),
                n(r.stop?.awakeElapsedMs ?? null), r.stop?.remainingRecords.length ?? "n/a", r.errors.length,
            ];
            return `| ${values.join(" | ")} |`;
        }),
    ].join("\n") + "\n";
}
