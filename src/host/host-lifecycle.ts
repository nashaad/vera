import { randomUUID } from "node:crypto";
import {
    closeSync, fstatSync, fsyncSync, mkdirSync, openSync, opendirSync, readFileSync,
    renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { hostLifecyclePathIn } from "../profile-paths.ts";
import { checkRecordIdentity, processIsAlive } from "./process-identity.ts";
import { isBuildIdText, type HostIdentity } from "./protocol.ts";
import type { HostLogEntry } from "./host-log.ts";

type HostLifecycleState = "starting" | "running" | "stopping";

interface HostLifecycleRecord {
    readonly schema_version: 1;
    readonly pid: number;
    readonly started_at: string;
    readonly build_id: string;
    readonly state: HostLifecycleState;
    readonly stop_recorded: boolean;
}

type LifecycleIdentity = Pick<HostIdentity, "pid" | "started_at"> & { readonly build_id: string };
type HostLogWriter = (entry: HostLogEntry) => boolean;

const MAX_RECORD_BYTES = 2_048;

class InvalidLifecycleRecord extends Error {}

export class HostLifecycle {
    private readonly path: string;
    private tracking = false;

    constructor(home: string, private readonly identity: LifecycleIdentity, private readonly log: HostLogWriter) {
        this.path = hostLifecyclePathIn(home);
    }

    start(): void {
        try {
            try {
                removeAbandonedTemps(this.path);
            } catch (error) {
                this.log({ type: "host_lifecycle_failed", error: error instanceof Error ? error.message : String(error) });
            }
            let previous: HostLifecycleRecord | undefined;
            try {
                previous = readRecord(this.path);
            } catch (error) {
                if (!(error instanceof InvalidLifecycleRecord)) throw error;
                this.log({ type: "host_lifecycle_failed", error: error.message });
            }
            if (previous !== undefined && !sameIdentity(previous, this.identity)
                && !previous.stop_recorded && !stillRunning(previous)) {
                if (!this.log({
                    type: "previous_host_unclean",
                    pid: previous.pid,
                    build_id: previous.build_id,
                    started_at: previous.started_at,
                    last_known_state: previous.state,
                })) return;
            }
            writeRecord(this.path, { schema_version: 1, ...this.identity, state: "starting", stop_recorded: false });
            this.tracking = true;
        } catch (error) {
            this.log({ type: "host_lifecycle_failed", error: error instanceof Error ? error.message : String(error) });
        }
    }

    running(): void {
        this.transition("running", false);
    }

    stopRecorded(): void {
        this.transition("stopping", true);
    }

    private transition(state: HostLifecycleState, stopRecorded: boolean): void {
        if (!this.tracking) return;
        try {
            const current = readRecord(this.path);
            if (current === undefined || !sameIdentity(current, this.identity)) return;
            writeRecord(this.path, { ...current, state, stop_recorded: stopRecorded });
        } catch (error) {
            this.log({ type: "host_lifecycle_failed", error: error instanceof Error ? error.message : String(error) });
        }
    }
}

function removeAbandonedTemps(path: string): void {
    const directory = dirname(path);
    let entries;
    try {
        entries = opendirSync(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    try {
        const prefix = `${basename(path)}.`;
        let entry;
        while ((entry = entries.readSync()) !== null) {
            if (!entry.name.startsWith(prefix) || entry.isDirectory()) continue;
            const match = /^(\d+)\.([0-9a-f-]{36})\.tmp$/.exec(entry.name.slice(prefix.length));
            const pid = Number(match?.[1]);
            if (match === null || !Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) continue;
            try { unlinkSync(join(directory, entry.name)); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
    } finally {
        entries.closeSync();
    }
}

function sameIdentity(left: Pick<HostLifecycleRecord, "pid" | "started_at">, right: LifecycleIdentity): boolean {
    return left.pid === right.pid && left.started_at === right.started_at;
}

function stillRunning(record: HostLifecycleRecord): boolean {
    return processIsAlive(record.pid) && checkRecordIdentity(record) !== "mismatch";
}

function readRecord(path: string): HostLifecycleRecord | undefined {
    let file: number;
    try {
        file = openSync(path, "r");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    try {
        if (fstatSync(file).size > MAX_RECORD_BYTES) throw new InvalidLifecycleRecord("Host lifecycle record is too large.");
        let value: unknown;
        try {
            value = JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
            if (error instanceof SyntaxError) throw new InvalidLifecycleRecord("Invalid host lifecycle record.");
            throw error;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidLifecycleRecord("Invalid host lifecycle record.");
        const record = value as Partial<HostLifecycleRecord>;
        if (record.schema_version !== 1 || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0
            || typeof record.started_at !== "string" || Number.isNaN(Date.parse(record.started_at))
            || record.started_at.length > 64 || !isBuildIdText(record.build_id)
            || (record.state !== "starting" && record.state !== "running" && record.state !== "stopping")
            || typeof record.stop_recorded !== "boolean") {
            throw new InvalidLifecycleRecord("Invalid host lifecycle record.");
        }
        return record as HostLifecycleRecord;
    } finally {
        closeSync(file);
    }
}

function writeRecord(path: string, record: HostLifecycleRecord): void {
    const serialized = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (serialized.length > MAX_RECORD_BYTES) throw new Error("Host lifecycle record is too large.");
    const data = Buffer.alloc(MAX_RECORD_BYTES, " ");
    serialized.copy(data);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        const file = openSync(temporary, "wx", 0o600);
        try {
            writeFileSync(file, data);
            fsyncSync(file);
        } finally {
            closeSync(file);
        }
        renameSync(temporary, path);
    } finally {
        try { unlinkSync(temporary); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}
