import type { Database } from "bun:sqlite";

import { MAX_LIVE_PROCESSES_PER_OWNER } from "../tools/process-limits.ts";
import type {
    ManagedProcessObservationSettlement,
    ManagedProcessObservationStart,
} from "../tools/process-runtime.ts";

export type ProcessObservationOutcome = "running" | "settled" | "interrupted";

export interface ProcessObservation extends ManagedProcessObservationStart {
    readonly executorId: string;
    readonly outcome: ProcessObservationOutcome;
    readonly delivered: boolean;
    readonly elapsedMs?: number;
    readonly exitCode?: number;
    readonly outputTail?: string;
    readonly outputTruncated?: boolean;
}

interface ObservationRow {
    readonly process_id: string;
    readonly executor_id: string;
    readonly owner_id: string;
    readonly extension_id: string;
    readonly description: string;
    readonly pid: number;
    readonly started_at: string;
    readonly outcome: ProcessObservationOutcome;
    readonly delivered: number;
    readonly elapsed_ms: number | null;
    readonly exit_code: number | null;
    readonly output_tail: string | null;
    readonly output_truncated: number | null;
}

const PAGE_LIMIT = 100;
const MAX_ID_BYTES = 256;
const MAX_DESCRIPTION_BYTES = 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_WIRE_OUTPUT_BYTES = 3 * MAX_OUTPUT_BYTES;
const MAX_OUTPUT_LINES = 20;

export function createProcessObservationTable(database: Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS process_observations (
            process_id TEXT PRIMARY KEY,
            executor_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            extension_id TEXT NOT NULL,
            description TEXT NOT NULL,
            pid INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('running', 'settled', 'interrupted')),
            delivered INTEGER NOT NULL DEFAULT 0,
            elapsed_ms REAL,
            exit_code INTEGER,
            output_tail TEXT,
            output_truncated INTEGER
        );
        CREATE INDEX IF NOT EXISTS process_observations_running
            ON process_observations (executor_id, outcome, process_id);
        CREATE INDEX IF NOT EXISTS process_observations_owner
            ON process_observations (owner_id, outcome);
        CREATE INDEX IF NOT EXISTS process_observations_pending
            ON process_observations (process_id) WHERE delivered = 0 AND outcome != 'running';
    `);
}

export class ProcessObservationStore {
    constructor(private readonly database: Database) {}

    register(executorId: string, start: ManagedProcessObservationStart): ProcessObservation {
        validateStart(executorId, start);
        return this.database.transaction(() => {
            const existing = this.get(start.processId);
            if (existing !== undefined) {
                assertIdentity(existing, executorId, start);
                return existing;
            }
            const active = this.database.query<{ count: number }, [string]>(
                "SELECT COUNT(*) AS count FROM process_observations WHERE owner_id = ? AND outcome = 'running'",
            ).get(start.ownerId)?.count ?? 0;
            if (active >= MAX_LIVE_PROCESSES_PER_OWNER) {
                throw new Error("Process observation limit reached for this owner");
            }
            this.database.query<null, [string, string, string, string, string, number, string]>(
                `INSERT INTO process_observations
                 (process_id, executor_id, owner_id, extension_id, description, pid, started_at, outcome)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
            ).run(start.processId, executorId, start.ownerId, start.extensionId, start.description, start.pid, start.startedAt);
            return this.get(start.processId)!;
        }).immediate();
    }

    settle(executorId: string, settlement: ManagedProcessObservationSettlement): ProcessObservation {
        validateStart(executorId, settlement);
        if (!Number.isFinite(settlement.elapsedMs) || settlement.elapsedMs < 0
            || (settlement.exitCode !== undefined && !Number.isSafeInteger(settlement.exitCode))
            || typeof settlement.outputTail !== "string"
            || Buffer.byteLength(settlement.outputTail, "utf8") > MAX_WIRE_OUTPUT_BYTES
            || typeof settlement.outputTruncated !== "boolean") {
            throw new Error("Invalid process settlement");
        }
        const tail = boundedTail(settlement.outputTail);
        const truncated = settlement.outputTruncated || tail.truncated;
        return this.database.transaction(() => {
            const current = this.requireIdentity(executorId, settlement);
            if (current.outcome === "settled") {
                if (current.elapsedMs !== settlement.elapsedMs || current.exitCode !== settlement.exitCode
                    || current.outputTail !== tail.text || current.outputTruncated !== truncated) {
                    throw new Error("Process settlement does not match the recorded outcome");
                }
                return current;
            }
            if (current.outcome !== "running") throw new Error("Process was already interrupted");
            this.database.query<null, [number, number | null, string, number, string]>(
                `UPDATE process_observations SET outcome = 'settled', elapsed_ms = ?, exit_code = ?,
                 output_tail = ?, output_truncated = ? WHERE process_id = ?`,
            ).run(settlement.elapsedMs, settlement.exitCode ?? null, tail.text, truncated ? 1 : 0, settlement.processId);
            return this.get(settlement.processId)!;
        }).immediate();
    }

    interrupt(executorId: string, ownerId: string, processId: string): ProcessObservation {
        return this.database.transaction(() => {
            const current = this.get(processId);
            if (current === undefined || current.executorId !== executorId || current.ownerId !== ownerId) {
                throw new Error("Process observation is not owned by this executor and session");
            }
            if (current.outcome === "running") {
                this.database.query<null, [string]>(
                    "UPDATE process_observations SET outcome = 'interrupted' WHERE process_id = ?",
                ).run(processId);
                return this.get(processId)!;
            }
            return current;
        }).immediate();
    }

    markDelivered(executorId: string, ownerId: string, processId: string): void {
        const current = this.get(processId);
        if (current === undefined || current.executorId !== executorId || current.ownerId !== ownerId) {
            throw new Error("Process observation is not owned by this executor and session");
        }
        if (current.outcome === "running") throw new Error("A running process cannot be delivered");
        this.database.query<null, [string]>(
            "UPDATE process_observations SET delivered = 1 WHERE process_id = ?",
        ).run(processId);
    }

    get(processId: string): ProcessObservation | undefined {
        const row = this.database.query<ObservationRow, [string]>(
            "SELECT * FROM process_observations WHERE process_id = ?",
        ).get(processId);
        return row === null ? undefined : observationFrom(row);
    }

    running(executorId: string, after: string, limit: number): ProcessObservation[] {
        return this.database.query<ObservationRow, [string, string, number]>(
            `SELECT * FROM process_observations WHERE executor_id = ? AND outcome = 'running'
             AND process_id > ? ORDER BY process_id LIMIT ?`,
        ).all(executorId, after, pageLimit(limit)).map(observationFrom);
    }

    pending(after: string, limit: number): ProcessObservation[] {
        return this.database.query<ObservationRow, [string, number]>(
            `SELECT * FROM process_observations WHERE delivered = 0 AND process_id > ?
             AND outcome != 'running' ORDER BY process_id LIMIT ?`,
        ).all(after, pageLimit(limit)).map(observationFrom);
    }

    private requireIdentity(executorId: string, start: ManagedProcessObservationStart): ProcessObservation {
        const current = this.get(start.processId);
        if (current === undefined) throw new Error("Unknown process observation");
        assertIdentity(current, executorId, start);
        return current;
    }
}

function validateStart(executorId: string, start: ManagedProcessObservationStart): void {
    for (const value of [executorId, start.processId, start.ownerId, start.extensionId]) {
        if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) {
            throw new Error("Invalid process observation identity");
        }
    }
    if (typeof start.description !== "string" || start.description.trim().length === 0
        || Buffer.byteLength(start.description, "utf8") > MAX_DESCRIPTION_BYTES
        || !Number.isSafeInteger(start.pid) || start.pid <= 0
        || typeof start.startedAt !== "string" || start.startedAt.length > 64
        || !Number.isFinite(Date.parse(start.startedAt))) {
        throw new Error("Invalid process observation start");
    }
}

function assertIdentity(current: ProcessObservation, executorId: string, start: ManagedProcessObservationStart): void {
    if (current.executorId !== executorId || current.ownerId !== start.ownerId
        || current.extensionId !== start.extensionId || current.processId !== start.processId
        || current.description !== start.description || current.pid !== start.pid || current.startedAt !== start.startedAt) {
        throw new Error("Process observation identity does not match");
    }
}

function observationFrom(row: ObservationRow): ProcessObservation {
    return {
        executorId: row.executor_id, ownerId: row.owner_id, processId: row.process_id,
        extensionId: row.extension_id, description: row.description, pid: row.pid, startedAt: row.started_at,
        outcome: row.outcome, delivered: row.delivered === 1,
        ...(row.elapsed_ms === null ? {} : { elapsedMs: row.elapsed_ms }),
        ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
        ...(row.output_tail === null ? {} : { outputTail: row.output_tail }),
        ...(row.output_truncated === null ? {} : { outputTruncated: row.output_truncated === 1 }),
    };
}

function pageLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PAGE_LIMIT) {
        throw new Error(`Process observation page size must be between 1 and ${PAGE_LIMIT}`);
    }
    return limit;
}

function boundedTail(output: string): { readonly text: string; readonly truncated: boolean } {
    const lines = output.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const kept = lines.slice(-MAX_OUTPUT_LINES).join("");
    const bytes = Buffer.from(kept, "utf8");
    let start = Math.max(0, bytes.length - MAX_OUTPUT_BYTES);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
    return { text: bytes.subarray(start).toString("utf8"), truncated: lines.length > MAX_OUTPUT_LINES || start > 0 };
}
