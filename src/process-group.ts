import { execFileSync } from "node:child_process";

import { checkRecordIdentity, parseElapsedTime, processIsAlive } from "./host/process-identity.ts";

export interface ProcessGroupIdentity {
    readonly pid: number;
    readonly started_at: string;
}

export interface ProcessGroupReads {
    readonly isAlive?: (pid: number) => boolean;
    readonly readStartedAt?: (pid: number) => number | undefined;
    readonly readCommand?: (pid: number) => string | undefined;
    readonly readProcessGroupSnapshot?: (pid: number) => readonly ProcessGroupMember[] | undefined;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ProcessGroupMember {
    readonly pid: number;
    readonly group: number;
    readonly state: string;
    readonly startedAt: number;
}

export type ProcessIdentityState = "same" | "gone" | "replaced" | "unverified";
export type ProcessGroupSignalResult =
    | Exclude<ProcessIdentityState, "same">
    | "not_group_leader"
    | "group_unverified"
    | "not_delivered"
    | "sent";
export type ProcessSignalResult = Exclude<ProcessIdentityState, "same"> | "not_delivered" | "sent";

export function readProcessGroupSnapshot(): readonly ProcessGroupMember[] | undefined {
    try {
        const output = execFileSync("ps", ["-axo", "pid=,pgid=,stat=,etime="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        const now = Date.now();
        const members: ProcessGroupMember[] = [];
        for (const line of output.split("\n")) {
            if (line.trim().length === 0) continue;
            const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
            if (match === null) return undefined;
            const pid = Number(match[1]);
            const group = Number(match[2]);
            const elapsed = parseElapsedTime(match[4]!);
            if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(group)
                || group < 1 || elapsed === undefined) return undefined;
            members.push({ pid, group, state: match[3]!, startedAt: now - elapsed });
        }
        return members;
    } catch {
        return undefined;
    }
}

export function processIdentityState(
    record: ProcessGroupIdentity,
    reads: ProcessGroupReads = {},
): ProcessIdentityState {
    if (!(reads.isAlive ?? processIsAlive)(record.pid)) return "gone";
    if (Number.isNaN(Date.parse(record.started_at))) return "unverified";
    const identity = checkRecordIdentity(record, reads.readStartedAt, reads.readCommand);
    if (identity === "unknown" && !(reads.isAlive ?? processIsAlive)(record.pid)) return "gone";
    return identity === "match" ? "same" : identity === "mismatch" ? "replaced" : "unverified";
}

export function signalVerifiedProcessGroup(
    record: ProcessGroupIdentity,
    signal: NodeJS.Signals,
    options: {
        readonly reads?: ProcessGroupReads;
        readonly checkIdentity?: () => ProcessIdentityState;
    } = {},
): ProcessGroupSignalResult {
    const reads = options.reads ?? {};
    if (!Number.isSafeInteger(record.pid) || record.pid < 2 || Number.isNaN(Date.parse(record.started_at))) {
        return "unverified";
    }
    const before = options.checkIdentity?.();
    if (before === "replaced" || before === "unverified") return before;
    let members: readonly ProcessGroupMember[] | undefined;
    try {
        members = (reads.readProcessGroupSnapshot ?? readProcessGroupSnapshot)(record.pid);
    } catch {
        return "group_unverified";
    }
    if (members === undefined) return "group_unverified";
    const leader = members.find((member) => member.pid === record.pid);
    if (leader !== undefined) {
        const identity = checkRecordIdentity(record, () => leader.startedAt);
        if (identity === "mismatch") return "replaced";
        if (identity !== "match") return "unverified";
        if (leader.group !== record.pid) return "not_group_leader";
    } else if (!members.some((member) => member.group === record.pid && !/^[ZX]/.test(member.state))) {
        return "gone";
    }
    try {
        (reads.kill ?? process.kill)(-record.pid, signal);
        return "sent";
    } catch {
        return "not_delivered";
    }
}

export function signalVerifiedProcess(
    record: ProcessGroupIdentity,
    signal: NodeJS.Signals,
    reads: ProcessGroupReads = {},
): ProcessSignalResult {
    const state = processIdentityState(record, reads);
    if (state !== "same") return state;
    try {
        (reads.kill ?? process.kill)(record.pid, signal);
        return "sent";
    } catch {
        return "not_delivered";
    }
}
