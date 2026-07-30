import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ConsumerRegistry } from "./consumers.ts";
import type { Inbox, InboxEntry } from "../store/inbox.ts";
import { SOURCE_GAP_KIND } from "../watch/source.ts";

/**
 * Starting a session because an entry arrived, rather than waking one that is
 * already running.
 *
 * Two gates, both required. The experimental subsystem flag is the config
 * switch checked where the inbox is opened; with it off there is no inbox and
 * this file never runs. The spawn toggle is a separate durable confirmation
 * the user gives once. A config file cannot set it, so a machine that only
 * copies configuration around never gains the ability to start sessions.
 *
 * Outgoing risk stays with the permission posture. A cold spawn always gets the
 * most restrictive posture the host supports and asks for everything. Nothing
 * an entry carries can widen it: the address is producer-supplied, so keying a
 * posture off it would let an entry author choose how permissive the session it
 * started is. Inheritance returns only once the host itself maps an address to
 * a live session it owns.
 */

/** The strictest built-in posture. Every spawn gets it. */
export const COLD_SPAWN_APPROVAL_MODE = "ask";

/**
 * The floor between two spawns for one address. Stricter than the wake floor:
 * a noisy source that only wakes a session costs one turn, while the same
 * source spawning costs a whole session each time.
 */
export const DEFAULT_MIN_SPAWN_INTERVAL_MS = 60_000;

/** How many entries one spawn scan reads. */
export const DEFAULT_MAX_ENTRIES_PER_SCAN = 100;

/** How many held entries are remembered before the oldest are forgotten. */
export const MAX_HELD_ENTRIES = 1_000;

/** The consumer label the controller reads the log under. */
export const SPAWN_CONSUMER_LABEL = "host:spawn";

export type HeldReason =
    | "subsystem-off"
    | "not-confirmed"
    | "rate-limited"
    | "no-target"
    | "self-caused";

export interface HeldEntry {
    readonly address: string;
    readonly seq: number;
    readonly reason: HeldReason;
}

export interface SpawnRequest {
    /** The consumer label the entry was addressed to. */
    readonly address: string;
    /** The entry that triggered the spawn. */
    readonly entry: InboxEntry;
    /** Entries coalesced into this one spawn, including `entry`. */
    readonly coalesced: number;
    /** The posture the spawned session starts under. */
    readonly approvalMode: string;
    /** Which entry, which source, which consumer. */
    readonly provenance: string;
}

export interface SpawnedSession {
    readonly label: string;
    /** Recorded before the session's first turn. */
    recordProvenance(text: string): Promise<void>;
}

/** `null` when the host has no target to start the session against. */
export type SpawnSessionFn = (
    request: SpawnRequest,
) => Promise<SpawnedSession | null>;

export interface SpawnGates {
    /** `experimental.inbox`, checked where the inbox is opened. */
    readonly subsystemEnabled: boolean;
    /** The durable confirmation. Never set by config. */
    readonly userConfirmed: boolean;
}

export function spawnOnEventEnabled(gates: SpawnGates): boolean {
    return gates.subsystemEnabled && gates.userConfirmed;
}

export interface InboxSpawnOptions {
    readonly inbox: Inbox;
    readonly consumers: ConsumerRegistry;
    readonly spawnSession: SpawnSessionFn;
    readonly consent: SpawnConsent;
    /** `experimental.inbox`. Required, because a default would fail open. */
    readonly subsystemEnabled: boolean;
    /** True when the entry was caused by a session this host knows. */
    readonly causedByKnownSession?: (entry: InboxEntry) => boolean;
    readonly minSpawnIntervalMs?: number;
    readonly maxEntriesPerScan?: number;
    readonly now?: () => number;
}

/** The confirmation, as a value the controller reads on every scan. */
export interface SpawnConsent {
    readonly confirmed: boolean;
}

interface ScannedEntry {
    readonly entry: InboxEntry;
    /** The address whose spawn outcome decides this entry, `null` when settled. */
    readonly address: string | null;
    readonly final: boolean;
}

interface AddressState {
    lastSpawnMs: number | null;
    pending: InboxEntry | null;
    coalesced: number;
}

export class InboxSpawnController {
    private readonly options: InboxSpawnOptions;
    private readonly consumers: ConsumerRegistry;
    private readonly minSpawnIntervalMs: number;
    private readonly maxEntriesPerScan: number;
    private readonly clock: () => number;
    private readonly addresses = new Map<string, AddressState>();
    private readonly heldEntries: HeldEntry[] = [];
    private heldDropped = 0;
    private queue: Promise<void> = Promise.resolve();
    private released = false;

    constructor(options: InboxSpawnOptions) {
        this.options = options;
        this.consumers = options.consumers;
        this.minSpawnIntervalMs = Math.max(
            0,
            options.minSpawnIntervalMs ?? DEFAULT_MIN_SPAWN_INTERVAL_MS,
        );
        this.maxEntriesPerScan = Math.max(
            1,
            options.maxEntriesPerScan ?? DEFAULT_MAX_ENTRIES_PER_SCAN,
        );
        this.clock = options.now ?? (() => Date.now());
        options.inbox.registerConsumer({
            nodeId: this.consumers.nodeId,
            label: SPAWN_CONSUMER_LABEL,
        });
    }

    get enabled(): boolean {
        return spawnOnEventEnabled({
            subsystemEnabled: this.options.subsystemEnabled,
            userConfirmed: this.options.consent.confirmed,
        });
    }

    /** Everything a scan declined to spawn for, oldest first. */
    held(): readonly HeldEntry[] {
        return [...this.heldEntries];
    }

    /** Held entries forgotten to the cap, so the loss is countable. */
    heldDroppedCount(): number {
        return this.heldDropped;
    }

    /** Serialized so two overlapping scans cannot spawn twice for one entry. */
    scan(): Promise<void> {
        if (this.released) {
            return Promise.resolve();
        }
        const next = this.queue.then(() => this.run());
        this.queue = next.then(
            () => undefined,
            () => undefined,
        );
        return this.queue;
    }

    release(): void {
        this.released = true;
    }

    /**
     * One pass over the unread tail.
     *
     * The offset moves only over a prefix of entries whose outcome is final:
     * spawned, or held for a reason no later retry can change. An entry held
     * because consent is off or because the address is rate limited leaves the
     * offset where it is, so turning consent on, or waiting out the interval,
     * still reaches it. The rescan costs one bounded read.
     */
    private async run(): Promise<void> {
        const id = {
            nodeId: this.consumers.nodeId,
            label: SPAWN_CONSUMER_LABEL,
        };
        const entries = this.options.inbox.read(id, {
            limit: this.maxEntriesPerScan,
        });
        if (entries.length === 0) {
            return;
        }
        // Unadvanced entries are read again next scan, so coalescing restarts
        // here rather than accumulating a count across scans.
        for (const state of this.addresses.values()) {
            state.pending = null;
            state.coalesced = 0;
        }
        const scanned = entries.map((entry) => this.classify(entry));
        const outcomes = await this.drainPending();
        let advanceTo = 0;
        for (const item of scanned) {
            const final = item.address === null
                ? item.final
                : item.final || (outcomes.get(item.address) ?? false);
            if (!final) {
                break;
            }
            advanceTo = item.entry.seq;
        }
        if (advanceTo > 0) {
            // The controller's own offset. Every real consumer keeps its own,
            // so moving this one never consumes an entry a dormant session
            // still has coming to it.
            this.options.inbox.advance(id, advanceTo);
        }
    }

    private classify(entry: InboxEntry): ScannedEntry {
        const address = entry.address;
        // A gap record is a status entry about the source itself; a session
        // must never be spawned to react to one.
        if (entry.kind === SOURCE_GAP_KIND) {
            return { entry, address: null, final: true };
        }
        if (address === null || this.consumers.get(address) !== undefined) {
            return { entry, address: null, final: true };
        }
        if (this.isSelfCaused(entry, address)) {
            this.hold(address, entry, "self-caused");
            return { entry, address: null, final: true };
        }
        if (!this.enabled) {
            this.hold(
                address,
                entry,
                this.options.subsystemEnabled ? "not-confirmed" : "subsystem-off",
            );
            return { entry, address: null, final: false };
        }
        const state = this.stateFor(address);
        if (state.pending === null) {
            state.pending = entry;
            state.coalesced = 1;
        } else {
            // Nothing queues a second spawn: the extra entries raise the count
            // on the one pending spawn and the session sees them all at once.
            state.coalesced += 1;
        }
        return { entry, address, final: false };
    }

    /** Per address: true when this scan finished with it, false when it holds. */
    private async drainPending(): Promise<Map<string, boolean>> {
        const now = this.clock();
        const outcomes = new Map<string, boolean>();
        for (const [address, state] of this.addresses) {
            const entry = state.pending;
            if (entry === null) {
                continue;
            }
            if (!this.maySpawn(state, now)) {
                this.hold(address, entry, "rate-limited");
                outcomes.set(address, false);
                continue;
            }
            const request = this.requestFor(address, entry, state.coalesced);
            const session = await this.options.spawnSession(request);
            if (session === null) {
                // The host has no target for this address and will not grow one
                // by being asked again with the same entry.
                this.hold(address, entry, "no-target");
                outcomes.set(address, true);
                state.pending = null;
                state.coalesced = 0;
                continue;
            }
            state.pending = null;
            state.coalesced = 0;
            state.lastSpawnMs = now;
            outcomes.set(address, true);
            await session.recordProvenance(request.provenance);
        }
        return outcomes;
    }

    private requestFor(
        address: string,
        entry: InboxEntry,
        coalesced: number,
    ): SpawnRequest {
        return {
            address,
            entry,
            coalesced,
            approvalMode: COLD_SPAWN_APPROVAL_MODE,
            provenance: renderProvenance(address, entry, coalesced),
        };
    }

    private maySpawn(state: AddressState, nowMs: number): boolean {
        if (this.minSpawnIntervalMs <= 0 || state.lastSpawnMs === null) {
            return true;
        }
        return nowMs - state.lastSpawnMs >= this.minSpawnIntervalMs;
    }

    /**
     * An entry a session caused can never start a session to react to it.
     *
     * The host predicate is the load-bearing half: it asks the host whether it
     * owns the session named on the entry. The address comparison is only
     * trusted when the entry also carries the complete (actor, session) pair of
     * a live consumer, because both fields come from whatever produced the
     * entry and a bare match would let a producer suppress any address it can
     * name.
     */
    private isSelfCaused(entry: InboxEntry, address: string): boolean {
        if (this.options.causedByKnownSession?.(entry) ?? false) {
            return true;
        }
        if (entry.session === null || entry.session !== address) {
            return false;
        }
        return this.consumers.liveHandles().some((handle) =>
            handle.selfEcho.actor !== null
            && handle.selfEcho.session !== null
            && handle.selfEcho.actor === entry.actor
            && handle.selfEcho.session === entry.session
        );
    }

    private stateFor(address: string): AddressState {
        const existing = this.addresses.get(address);
        if (existing !== undefined) {
            return existing;
        }
        const state: AddressState = {
            lastSpawnMs: null,
            pending: null,
            coalesced: 0,
        };
        this.addresses.set(address, state);
        return state;
    }

    private hold(
        address: string,
        entry: InboxEntry,
        reason: HeldReason,
    ): void {
        if (
            this.heldEntries.some(
                (held) => held.seq === entry.seq && held.reason === reason,
            )
        ) {
            return;
        }
        this.heldEntries.push({ address, seq: entry.seq, reason });
        while (this.heldEntries.length > MAX_HELD_ENTRIES) {
            this.heldEntries.shift();
            this.heldDropped += 1;
        }
    }
}

/** Payloads are not interpolated here either; nothing of the entry body is read. */
function renderProvenance(
    address: string,
    entry: InboxEntry,
    coalesced: number,
): string {
    const also = coalesced > 1
        ? ` and ${coalesced - 1} more entries for the same consumer`
        : "";
    return [
        `Started by inbox entry ${entry.seq}${also}.`,
        `source: ${entry.source}/${entry.kind}`,
        `consumer: ${address}`,
    ].join("\n");
}

/**
 * The second gate, on disk. It is a separate file from the config on purpose:
 * loading, copying or generating configuration must not be able to turn
 * spawning on, so the only writer is an explicit confirmation.
 */
export class SpawnConsentStore implements SpawnConsent {
    private readonly path: string;
    private confirmedAt: string | null;
    private stamp: string | null;

    private constructor(path: string) {
        this.path = path;
        this.confirmedAt = null;
        this.stamp = null;
        this.refresh();
    }

    static open(path: string = defaultSpawnConsentPath()): SpawnConsentStore {
        return new SpawnConsentStore(path);
    }

    /**
     * Read through to the file rather than cached at open. Deleting the file is
     * how consent is withdrawn, and a withdrawal that only takes effect at the
     * next host start is not a withdrawal.
     */
    get confirmed(): boolean {
        this.refresh();
        return this.confirmedAt !== null;
    }

    /** The timestamp the user confirmed at, or `null` when consent is absent. */
    get confirmedAtIso(): string | null {
        this.refresh();
        return this.confirmedAt;
    }

    /** Call only from a surface where the user answered, not from config load. */
    confirm(at: string = new Date().toISOString()): void {
        this.write(at);
        this.refresh(true);
    }

    revoke(): void {
        this.write(null);
        this.refresh(true);
    }

    private refresh(force = false): void {
        const stamp = fileStamp(this.path);
        if (!force && stamp === this.stamp) {
            return;
        }
        this.stamp = stamp;
        this.confirmedAt = stamp === null ? null : readConfirmedAt(this.path);
    }

    private write(at: string | null): void {
        mkdirSync(dirname(this.path), { recursive: true });
        const body = `${JSON.stringify(
            at === null ? {} : { spawn_on_event: { confirmed_at: at } },
            null,
            2,
        )}\n`;
        // Written whole or not at all: a torn file would read as no consent on
        // one host start and as consent on the next.
        const temporary = `${this.path}.tmp-${process.pid}`;
        writeFileSync(temporary, body);
        renameSync(temporary, this.path);
    }
}

/** Size and mtime, so a scan can skip the parse when nothing changed. */
function fileStamp(path: string): string | null {
    try {
        const stats = statSync(path);
        return `${stats.size}:${stats.mtimeMs}`;
    } catch {
        return null;
    }
}

export function defaultSpawnConsentPath(): string {
    return join(homedir(), ".vera", "spawn-consent.json");
}

/**
 * Consent is exactly `{"spawn_on_event": {"confirmed_at": "<ISO timestamp>"}}`.
 * The shape is strict because anything looser makes stray text a yes: a file
 * that happens to hold a non-empty string would have granted it.
 */
function readConfirmedAt(path: string): string | null {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return null;
        }
        const value = (parsed as { spawn_on_event?: unknown }).spawn_on_event;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        const at = (value as { confirmed_at?: unknown }).confirmed_at;
        if (typeof at !== "string" || Number.isNaN(Date.parse(at))) {
            return null;
        }
        return at;
    } catch {
        // An unreadable consent file is no consent, never an assumed yes.
        return null;
    }
}
