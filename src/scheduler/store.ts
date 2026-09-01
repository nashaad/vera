import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
    EmittedScheduleRun,
    PendingScheduleRun,
    ScheduleDefinition,
    ScheduleRun,
} from "./types.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";
import { backupSqliteDatabase } from "../store/sqlite-backup.ts";

export const SCHEDULE_SCHEMA_VERSION = 1;

interface ScheduleRow {
    id: string;
    cron: string;
    timezone: string;
    address: string;
    payload: string;
    next_run_at: string;
    enabled: number;
    created_at: string;
    updated_at: string;
}

interface RunRow {
    schedule_id: string;
    scheduled_for: string;
    status: string;
    inbox_seq: number | null;
    created_at: string;
    emitted_at: string | null;
}

interface PendingRunRow extends RunRow {
    address: string;
    payload: string;
}

export class ScheduleStore {
    private readonly database: Database;

    private constructor(database: Database) {
        this.database = database;
        this.database.exec("PRAGMA journal_mode = WAL");
        this.database.exec("PRAGMA foreign_keys = ON");
        this.database.exec("PRAGMA busy_timeout = 5000");
        migrate(this.database);
    }

    static open(path: string = defaultSchedulePath()): ScheduleStore {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        const database = new Database(path, { create: true });
        try {
            return new ScheduleStore(database);
        } catch (error) {
            database.close();
            throw error;
        }
    }

    close(): void {
        this.database.close();
    }

    backupTo(destinationPath: string): void {
        backupSqliteDatabase(this.database, destinationPath);
    }

    create(input: {
        readonly id: string;
        readonly cron: string;
        readonly timezone: string;
        readonly address: string;
        readonly payload: string;
        readonly nextRunAt: string;
        readonly now: string;
    }): ScheduleDefinition {
        try {
            this.database.query<null, [string, string, string, string, string, string, string, string]>(
                `INSERT INTO schedules (
                    id, cron, timezone, address, payload, next_run_at,
                    enabled, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            ).run(
                input.id,
                input.cron,
                input.timezone,
                input.address,
                input.payload,
                input.nextRunAt,
                input.now,
                input.now,
            );
        } catch (error) {
            if (String(error).includes("UNIQUE constraint failed")) {
                throw new Error(`schedule ${input.id} already exists`);
            }
            throw error;
        }
        return this.get(input.id)!;
    }

    get(id: string): ScheduleDefinition | undefined {
        const row = this.database.query<ScheduleRow, [string]>(
            `SELECT id, cron, timezone, address, payload, next_run_at,
                    enabled, created_at, updated_at
             FROM schedules WHERE id = ?`,
        ).get(id);
        return row === null ? undefined : scheduleFromRow(row);
    }

    list(): ScheduleDefinition[] {
        return this.database.query<ScheduleRow, []>(
            `SELECT id, cron, timezone, address, payload, next_run_at,
                    enabled, created_at, updated_at
             FROM schedules ORDER BY id`,
        ).all().map(scheduleFromRow);
    }

    due(now: string): ScheduleDefinition[] {
        return this.database.query<ScheduleRow, [string]>(
            `SELECT id, cron, timezone, address, payload, next_run_at,
                    enabled, created_at, updated_at
             FROM schedules
             WHERE enabled = 1 AND next_run_at <= ?
             ORDER BY next_run_at, id`,
        ).all(now).map(scheduleFromRow);
    }

    nextDueAt(): string | null {
        const row = this.database.query<{ next_run_at: string | null }, []>(
            `SELECT MIN(next_run_at) AS next_run_at
             FROM schedules WHERE enabled = 1`,
        ).get();
        return row?.next_run_at ?? null;
    }

    planDue(
        id: string,
        scheduledFor: string,
        nextRunAt: string,
        now: string,
    ): boolean {
        const transaction = this.database.transaction(() => {
            const updated = this.database.query<null, [string, string, string, string]>(
                `UPDATE schedules
                 SET next_run_at = ?, updated_at = ?
                 WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
            ).run(nextRunAt, now, id, scheduledFor);
            if (updated.changes !== 1) return false;
            this.database.query<null, [string, string, string]>(
                `INSERT OR IGNORE INTO schedule_runs (
                    schedule_id, scheduled_for, status, created_at
                 ) VALUES (?, ?, 'pending', ?)`,
            ).run(id, scheduledFor, now);
            return true;
        });
        return transaction();
    }

    createManualRun(id: string, now: Date): ScheduleRun {
        if (this.get(id) === undefined) throw new Error(`unknown schedule ${id}`);
        for (let offset = 0; offset < 1_000; offset += 1) {
            const scheduledFor = new Date(now.getTime() + offset).toISOString();
            const result = this.database.query<null, [string, string, string]>(
                `INSERT OR IGNORE INTO schedule_runs (
                    schedule_id, scheduled_for, status, created_at
                 ) VALUES (?, ?, 'pending', ?)`,
            ).run(id, scheduledFor, now.toISOString());
            if (result.changes === 1) return this.run(id, scheduledFor)!;
        }
        throw new Error(`could not allocate a manual run for schedule ${id}`);
    }

    pendingRuns(): PendingScheduleRun[] {
        return this.database.query<PendingRunRow, []>(
            `SELECT r.schedule_id, r.scheduled_for, r.status, r.inbox_seq,
                    r.created_at, r.emitted_at, s.address, s.payload
             FROM schedule_runs r
             JOIN schedules s ON s.id = r.schedule_id
             WHERE r.status = 'pending'
             ORDER BY r.scheduled_for, r.schedule_id`,
        ).all().map(pendingRunFromRow);
    }

    run(scheduleId: string, scheduledFor: string): ScheduleRun | undefined {
        const row = this.database.query<RunRow, [string, string]>(
            `SELECT schedule_id, scheduled_for, status, inbox_seq,
                    created_at, emitted_at
             FROM schedule_runs
             WHERE schedule_id = ? AND scheduled_for = ?`,
        ).get(scheduleId, scheduledFor);
        return row === null ? undefined : runFromRow(row);
    }

    listRuns(scheduleId: string, limit?: number): ScheduleRun[] {
        if (limit === undefined) {
            return this.database.query<RunRow, [string]>(
                `SELECT schedule_id, scheduled_for, status, inbox_seq,
                        created_at, emitted_at
                 FROM schedule_runs WHERE schedule_id = ?
                 ORDER BY scheduled_for`,
            ).all(scheduleId).map(runFromRow);
        }
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error("schedule run limit must be a positive integer");
        }
        return this.database.query<RunRow, [string, number]>(
            `SELECT schedule_id, scheduled_for, status, inbox_seq,
                    created_at, emitted_at
             FROM schedule_runs WHERE schedule_id = ?
             ORDER BY scheduled_for DESC
             LIMIT ?`,
        ).all(scheduleId, limit).map(runFromRow);
    }

    recentlyEmitted(limit: number): readonly EmittedScheduleRun[] {
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error("emitted schedule run limit must be a positive integer");
        }
        return this.database.query<EmittedRunRow, [number]>(
            `SELECT r.schedule_id, r.scheduled_for, r.status, r.inbox_seq,
                    r.created_at, r.emitted_at, s.address
             FROM schedule_runs r
             JOIN schedules s ON s.id = r.schedule_id
             WHERE r.status = 'emitted' AND r.emitted_at IS NOT NULL
             ORDER BY r.emitted_at DESC
             LIMIT ?`,
        ).all(limit).flatMap((row) => {
            const run = runFromRow(row);
            return run.status !== "emitted" || run.emittedAt === null
                ? []
                : [{
                    ...run,
                    status: "emitted" as const,
                    emittedAt: run.emittedAt,
                    address: row.address,
                }];
        });
    }

    countRuns(scheduleId: string): number {
        const row = this.database.query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM schedule_runs
             WHERE schedule_id = ?`,
        ).get(scheduleId);
        return row?.count ?? 0;
    }

    markEmitted(
        scheduleId: string,
        scheduledFor: string,
        inboxSeq: number,
        now: string,
    ): void {
        this.database.query<null, [number, string, string, string]>(
            `UPDATE schedule_runs
             SET status = 'emitted', inbox_seq = ?, emitted_at = ?
             WHERE schedule_id = ? AND scheduled_for = ? AND status = 'pending'`,
        ).run(inboxSeq, now, scheduleId, scheduledFor);
    }

    setEnabled(id: string, enabled: boolean, now: string): ScheduleDefinition {
        const result = this.database.query<null, [number, string, string]>(
            `UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?`,
        ).run(enabled ? 1 : 0, now, id);
        if (result.changes !== 1) throw new Error(`unknown schedule ${id}`);
        return this.get(id)!;
    }

    remove(id: string): boolean {
        return this.database.query<null, [string]>(
            "DELETE FROM schedules WHERE id = ?",
        ).run(id).changes === 1;
    }
}

export function defaultSchedulePath(): string {
    return join(veraRuntimeDirectory(), "schedules.db");
}

function scheduleFromRow(row: ScheduleRow): ScheduleDefinition {
    return {
        id: row.id,
        cron: row.cron,
        timezone: row.timezone,
        address: row.address,
        payload: row.payload,
        nextRunAt: row.next_run_at,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

interface EmittedRunRow extends RunRow {
    readonly address: string;
}

function runFromRow(row: RunRow): ScheduleRun {
    if (row.status !== "pending" && row.status !== "emitted") {
        throw new Error(`invalid schedule run status ${row.status}`);
    }
    return {
        scheduleId: row.schedule_id,
        scheduledFor: row.scheduled_for,
        status: row.status,
        inboxSeq: row.inbox_seq,
        createdAt: row.created_at,
        emittedAt: row.emitted_at,
    };
}

function pendingRunFromRow(row: PendingRunRow): PendingScheduleRun {
    return {
        ...runFromRow(row),
        status: "pending",
        address: row.address,
        payload: row.payload,
    };
}

function migrate(database: Database): void {
    const version = storedVersion(database);
    if (version > SCHEDULE_SCHEMA_VERSION) {
        throw new Error(
            `schedule database schema ${version} is newer than supported schema ${SCHEDULE_SCHEMA_VERSION}`,
        );
    }
    if (version >= 1) return;
    const migration = database.transaction(() => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY,
            cron TEXT NOT NULL,
            timezone TEXT NOT NULL,
            address TEXT NOT NULL,
            payload TEXT NOT NULL,
            next_run_at TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS schedules_due
            ON schedules (enabled, next_run_at, id);

        CREATE TABLE IF NOT EXISTS schedule_runs (
            schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
            scheduled_for TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'emitted')),
            inbox_seq INTEGER,
            created_at TEXT NOT NULL,
            emitted_at TEXT,
            PRIMARY KEY (schedule_id, scheduled_for)
        );

    `);
        database.exec("PRAGMA user_version = 1");
    });
    migration();
}

function storedVersion(database: Database): number {
    const row = database
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get();
    return row?.user_version ?? 0;
}
