import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { veraRuntimeDirectory } from "../profile-paths.ts";

/**
 * One durable inbox per Vera host: an append-only log of entries plus one
 * offset per consumer. The host owns every offset; no agent is ever handed a
 * cursor to keep.
 *
 * Addressing is a filter hint, not exclusivity. An addressed entry stays
 * visible to any consumer that asks for it, so there are no private channels.
 *
 * Payloads are inert data. Nothing here interpolates or evaluates a payload;
 * it is stored and returned as an opaque JSON string.
 */

export const INBOX_SCHEMA_VERSION = 3;

/** A consumer is identified by (nodeId, label) everywhere; the bare label is
 * display sugar. Offsets are durable per pair, so a returning consumer resumes
 * where it stopped instead of jumping to the tail. */
export interface ConsumerId {
    readonly nodeId: string;
    readonly label: string;
}

export interface InboxEntryInput {
    readonly source: string;
    readonly kind: string;
    /** Copied from the source event so self-echo filtering is a query. */
    readonly actor?: string | null;
    readonly session?: string | null;
    /** Filter hint, never exclusivity. */
    readonly address?: string | null;
    /** Opaque JSON text. */
    readonly payload: string;
    /** ISO-8601. Defaults to now. */
    readonly ts?: string;
}

export interface InboxEntry {
    readonly seq: number;
    readonly source: string;
    readonly kind: string;
    readonly actor: string | null;
    readonly session: string | null;
    readonly address: string | null;
    readonly payload: string;
    readonly ts: string;
}

export interface InboxReadOptions {
    readonly limit: number;
    /**
     * Keeps unaddressed entries and entries addressed to one of these values.
     * Absent means no address filtering at all.
     */
    readonly addresses?: readonly string[];
    /** Drops entries whose (actor, session) match, so a turn is not woken by
     * the events that turn caused. */
    readonly excludeOrigin?: {
        readonly actor: string | null;
        readonly session: string | null;
    };
    /** Entry kinds omitted from bookkeeping such as unread notices. */
    readonly excludeKinds?: readonly string[];
}

export interface InboxUnreadStats {
    readonly count: number;
    readonly oldestTs: string | null;
}

export interface InboxAcknowledgement {
    readonly offset: number;
    readonly receipt?: InboxEntry;
}

interface EntryRow {
    seq: number;
    source: string;
    kind: string;
    actor: string | null;
    session: string | null;
    address: string | null;
    payload: string;
    ts: string;
}

export class Inbox {
    private readonly database: Database;

    private constructor(database: Database) {
        this.database = database;
        this.database.exec("PRAGMA journal_mode = WAL");
        this.database.exec("PRAGMA foreign_keys = ON");
        this.database.exec("PRAGMA busy_timeout = 5000");
        migrate(this.database);
    }

    /** `path` may be `:memory:`. Parent directories are created. */
    static open(path: string): Inbox {
        if (path !== ":memory:") {
            mkdirSync(dirname(path), { recursive: true });
        }
        // Native peer messages have no upstream source to replay. Opening is
        // therefore fail-closed: silently replacing a damaged database would
        // turn a recoverable startup failure into permanent message loss.
        return new Inbox(new Database(path, { create: true }));
    }

    close(): void {
        this.database.close();
    }

    /**
     * Appends one entry and returns it with its assigned seq. Never blocks on
     * a consumer: appending and advancing an offset are separate operations.
     */
    append(entry: InboxEntryInput): InboxEntry {
        const ts = entry.ts ?? new Date().toISOString();
        const row = this.database
            .query<EntryRow, [string, string, string | null, string | null, string | null, string, string]>(
                `INSERT INTO entries (source, kind, actor, session, address, payload, ts)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 RETURNING seq, source, kind, actor, session, address, payload, ts`,
            )
            .get(
                entry.source,
                entry.kind,
                entry.actor ?? null,
                entry.session ?? null,
                entry.address ?? null,
                entry.payload,
                ts,
            );
        if (row === null) {
            throw new Error("inbox append returned no row");
        }
        return row;
    }

    /** Commits a producer occurrence and its source-scoped retry key together. */
    appendOnce(
        source: string,
        key: string,
        entry: InboxEntryInput,
    ): { readonly entry: InboxEntry; readonly created: boolean } {
        if (source.length === 0 || key.length === 0) {
            throw new Error("inbox producer source and key cannot be empty");
        }
        return this.database.transaction(() => {
            const existing = this.database.query<{ seq: number }, [string, string]>(
                `SELECT seq FROM producer_entries
                 WHERE producer_source = ? AND producer_key = ?`,
            ).get(source, key);
            if (existing !== null) {
                const stored = this.entry(existing.seq);
                if (stored === undefined) {
                    throw new Error("inbox producer key points to a missing entry");
                }
                return { entry: stored, created: false } as const;
            }
            const stored = this.append(entry);
            this.database.query<null, [string, string, number]>(
                `INSERT INTO producer_entries (
                    producer_source, producer_key, seq
                 ) VALUES (?, ?, ?)`,
            ).run(source, key, stored.seq);
            return { entry: stored, created: true } as const;
        })();
    }

    /** Appends several entries in one transaction, in the given order. */
    appendAll(entries: readonly InboxEntryInput[]): InboxEntry[] {
        const run = this.database.transaction((batch: readonly InboxEntryInput[]) =>
            batch.map((entry) => this.append(entry)),
        );
        return run(entries);
    }

    /** One entry by its stable local message id. */
    entry(seq: number): InboxEntry | undefined {
        return this.database
            .query<EntryRow, [number]>(
                `SELECT seq, source, kind, actor, session, address, payload, ts
                 FROM entries WHERE seq = ?`,
            )
            .get(seq) ?? undefined;
    }

    /** The seq of the newest entry, or 0 when the log is empty. */
    tail(): number {
        const row = this.database
            .query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM entries")
            .get();
        return row?.seq ?? 0;
    }

    /**
     * Records a consumer if it is unknown, starting it at the current tail so
     * a brand new consumer does not replay history. A consumer that already
     * has an offset keeps it; this is safe to call on every hello.
     */
    registerConsumer(consumer: ConsumerId): number {
        const start = this.tail();
        this.database
            .query<null, [string, string, number, string]>(
                `INSERT INTO consumer_offsets (node_id, label, seq, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (node_id, label) DO NOTHING`,
            )
            .run(consumer.nodeId, consumer.label, start, new Date().toISOString());
        return this.offsetOf(consumer) ?? start;
    }

    /** `null` when the consumer has never been registered. */
    offsetOf(consumer: ConsumerId): number | null {
        const row = this.database
            .query<{ seq: number }, [string, string]>(
                "SELECT seq FROM consumer_offsets WHERE node_id = ? AND label = ?",
            )
            .get(consumer.nodeId, consumer.label);
        return row?.seq ?? null;
    }

    listConsumers(): { consumer: ConsumerId; seq: number; updatedAt: string }[] {
        return this.database
            .query<{ node_id: string; label: string; seq: number; updated_at: string }, []>(
                "SELECT node_id, label, seq, updated_at FROM consumer_offsets ORDER BY node_id, label",
            )
            .all()
            .map((row) => ({
                consumer: { nodeId: row.node_id, label: row.label },
                seq: row.seq,
                updatedAt: row.updated_at,
            }));
    }

    /**
     * Entries strictly after the consumer's offset, in seq order, capped by
     * `limit`. Reading does not move the offset.
     */
    read(consumer: ConsumerId, options: InboxReadOptions): InboxEntry[] {
        const after = this.offsetOf(consumer);
        if (after === null) {
            throw new Error(
                `unknown inbox consumer ${consumer.nodeId}/${consumer.label}`,
            );
        }
        return this.readAfter(after, options);
    }

    /** The same query without a consumer, for callers that hold a seq already. */
    readAfter(after: number, options: InboxReadOptions): InboxEntry[] {
        const { clauses, parameters } = readPredicate(after, options);
        parameters.push(Math.max(0, options.limit));
        return this.database
            .query<EntryRow, (string | number | null)[]>(
                `SELECT seq, source, kind, actor, session, address, payload, ts
                 FROM entries
                 WHERE ${clauses.join(" AND ")}
                 ORDER BY seq
                 LIMIT ?`,
            )
            .all(...parameters);
    }

    /** Counts unread entries without returning their foreign payloads. */
    unreadStats(consumer: ConsumerId, options: InboxReadOptions): InboxUnreadStats {
        const after = this.offsetOf(consumer);
        if (after === null) {
            throw new Error(
                `unknown inbox consumer ${consumer.nodeId}/${consumer.label}`,
            );
        }
        const { clauses, parameters } = readPredicate(after, options);
        const row = this.database
            .query<{ count: number; oldest_ts: string | null }, (string | number | null)[]>(
                `SELECT COUNT(*) AS count, MIN(ts) AS oldest_ts
                 FROM entries
                 WHERE ${clauses.join(" AND ")}`,
            )
            .get(...parameters);
        return {
            count: row?.count ?? 0,
            oldestTs: row?.oldest_ts ?? null,
        };
    }

    /**
     * The resume token last persisted for a watch, or `null` for a watch that
     * has never admitted anything. Keyed by canonical watch id, which belongs
     * to the host, so a cursor outlives the extension that declared the watch.
     * The value is opaque: it is stored and returned, never parsed.
     */
    watchCursor(watchId: string): string | null {
        const row = this.database
            .query<{ cursor: string }, [string]>(
                "SELECT cursor FROM watch_cursors WHERE watch_id = ?",
            )
            .get(watchId);
        return row?.cursor ?? null;
    }

    /** Called only after the corresponding entries are durably appended. */
    setWatchCursor(watchId: string, cursor: string): void {
        this.database
            .query<null, [string, string, string]>(
                `INSERT INTO watch_cursors (watch_id, cursor, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT (watch_id) DO UPDATE
                 SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
            )
            .run(watchId, cursor, new Date().toISOString());
    }

    listWatchCursors(): { watchId: string; cursor: string; updatedAt: string }[] {
        return this.database
            .query<{ watch_id: string; cursor: string; updated_at: string }, []>(
                "SELECT watch_id, cursor, updated_at FROM watch_cursors ORDER BY watch_id",
            )
            .all()
            .map((row) => ({
                watchId: row.watch_id,
                cursor: row.cursor,
                updatedAt: row.updated_at,
            }));
    }

    /**
     * Moves a consumer forward to `seq`. Offsets never move backwards, so a
     * replayed delivery cannot rewind the log.
     */
    advance(consumer: ConsumerId, seq: number): number {
        if (this.offsetOf(consumer) === null) {
            throw new Error(
                `unknown inbox consumer ${consumer.nodeId}/${consumer.label}`,
            );
        }
        this.database
            .query<null, [number, string, string, string]>(
                `UPDATE consumer_offsets
                 SET seq = MAX(seq, ?), updated_at = ?
                 WHERE node_id = ? AND label = ?`,
            )
            .run(seq, new Date().toISOString(), consumer.nodeId, consumer.label);
        return this.offsetOf(consumer) ?? seq;
    }

    /**
     * Advances after a durable tool result and optionally records its complete
     * retrieval receipt in the same transaction. Replayed callbacks are a
     * no-op, which makes receipt creation exactly-once per offset crossing.
     */
    acknowledge(
        consumer: ConsumerId,
        throughSeq: number,
        receipt?: InboxEntryInput,
    ): InboxAcknowledgement {
        if (!Number.isSafeInteger(throughSeq) || throughSeq <= 0) {
            throw new Error("inbox acknowledgement seq must be positive");
        }
        const run = this.database.transaction((): InboxAcknowledgement => {
            const before = this.offsetOf(consumer);
            if (before === null) {
                throw new Error(
                    `unknown inbox consumer ${consumer.nodeId}/${consumer.label}`,
                );
            }
            if (before >= throughSeq) return { offset: before };
            if (this.entry(throughSeq) === undefined) {
                throw new Error(`unknown inbox entry ${throughSeq}`);
            }
            this.database
                .query<null, [number, string, string, string]>(
                    `UPDATE consumer_offsets
                     SET seq = ?, updated_at = ?
                     WHERE node_id = ? AND label = ?`,
                )
                .run(
                    throughSeq,
                    new Date().toISOString(),
                    consumer.nodeId,
                    consumer.label,
                );
            const storedReceipt = receipt === undefined
                ? undefined
                : this.append(receipt);
            return {
                offset: throughSeq,
                ...(storedReceipt === undefined
                    ? {}
                    : { receipt: storedReceipt }),
            };
        });
        return run();
    }
}

function readPredicate(
    after: number,
    options: InboxReadOptions,
): { clauses: string[]; parameters: (string | number | null)[] } {
    const clauses = ["seq > ?"];
    const parameters: (string | number | null)[] = [after];
    if (options.addresses !== undefined) {
        const placeholders = options.addresses.map(() => "?").join(", ");
        clauses.push(
            options.addresses.length === 0
                ? "address IS NULL"
                : `(address IS NULL OR address IN (${placeholders}))`,
        );
        parameters.push(...options.addresses);
    }
    if (options.excludeOrigin !== undefined) {
        clauses.push("NOT (actor IS ? AND session IS ?)");
        parameters.push(options.excludeOrigin.actor, options.excludeOrigin.session);
    }
    if (options.excludeKinds !== undefined && options.excludeKinds.length > 0) {
        clauses.push(
            `kind NOT IN (${options.excludeKinds.map(() => "?").join(", ")})`,
        );
        parameters.push(...options.excludeKinds);
    }
    return { clauses, parameters };
}

export function defaultInboxPath(): string {
    return join(veraRuntimeDirectory(), "inbox.db");
}

export function inboxEnabled(config: InboxFeatureConfig): boolean {
    return config.experimental?.inbox === true;
}

/**
 * The one gate for the subsystem. `null` means the feature is off, and nothing
 * downstream runs: no file, no tables, no offsets. Callers hold the `Inbox`
 * or nothing, so the flag is never re-checked inside the log.
 */
export function openInboxIfEnabled(
    config: InboxFeatureConfig,
    path: string = defaultInboxPath(),
): Inbox | null {
    return inboxEnabled(config) ? Inbox.open(path) : null;
}

export interface InboxFeatureConfig {
    readonly experimental?: { readonly inbox?: boolean };
}

/**
 * Steps run only when the stored `user_version` is behind them, and the version
 * is stamped per step. Re-running every statement on every open worked only
 * because each one was idempotent; the first step that is not would have run
 * against an already-migrated file.
 */
function migrate(database: Database): void {
    let version = storedVersion(database);
    for (const [index, step] of MIGRATIONS.entries()) {
        const target = index + 1;
        if (version >= target) {
            continue;
        }
        step(database);
        database.exec(`PRAGMA user_version = ${target}`);
        version = target;
    }
}

function storedVersion(database: Database): number {
    const row = database
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get();
    return row?.user_version ?? 0;
}

type Migration = (database: Database) => void;

const MIGRATIONS: readonly Migration[] = [
    (database) => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS entries (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            kind TEXT NOT NULL,
            actor TEXT,
            session TEXT,
            address TEXT,
            payload TEXT NOT NULL,
            ts TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS entries_address ON entries (address, seq);

        CREATE TABLE IF NOT EXISTS watch_cursors (
            watch_id TEXT PRIMARY KEY,
            cursor TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS consumer_offsets (
            node_id TEXT NOT NULL,
            label TEXT NOT NULL,
            seq INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (node_id, label)
        );
    `);
    },
    (database) => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS watch_cursors (
            watch_id TEXT PRIMARY KEY,
            cursor TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
    },
    (database) => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS producer_entries (
            producer_source TEXT NOT NULL,
            producer_key TEXT NOT NULL,
            seq INTEGER NOT NULL REFERENCES entries(seq),
            PRIMARY KEY (producer_source, producer_key)
        );
    `);
    },
];
