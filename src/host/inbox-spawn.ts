import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ConsumerRegistry } from "./consumers.ts";
import type { Inbox, InboxEntry } from "../store/inbox.ts";

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
 * Outgoing risk stays with the permission posture. A spawn inherits the
 * posture of the label's prior session when there is one, and otherwise gets
 * the most restrictive posture the host supports and asks for everything.
 */

/** The strictest built-in posture. A spawn with nothing to inherit gets this. */
export const COLD_SPAWN_APPROVAL_MODE = "ask";

/**
 * The floor between two spawns for one address. Stricter than the wake floor:
 * a noisy source that only wakes a session costs one turn, while the same
 * source spawning costs a whole session each time.
 */
export const DEFAULT_MIN_SPAWN_INTERVAL_MS = 60_000;

/** How many entries one spawn scan reads. */
export const DEFAULT_MAX_ENTRIES_PER_SCAN = 100;

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
    /** False when the inbox subsystem flag is off. */
    readonly subsystemEnabled?: boolean;
    /** The posture a label's prior session ran under, when one existed. */
    readonly inheritedApprovalMode?: (address: string) => string | undefined;
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
            subsystemEnabled: this.options.subsystemEnabled ?? true,
            userConfirmed: this.options.consent.confirmed,
        });
    }

    /** Everything a scan declined to spawn for, oldest first. */
    held(): readonly HeldEntry[] {
        return [...this.heldEntries];
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

    private async run(): Promise<void> {
        const id = {
            nodeId: this.consumers.nodeId,
            label: SPAWN_CONSUMER_LABEL,
        };
        const entries = this.options.inbox.read(id, {
            limit: this.maxEntriesPerScan,
        });
        for (const entry of entries) {
            this.classify(entry);
        }
        if (entries.length > 0) {
            // The controller's own offset. Every real consumer keeps its own,
            // so moving this one never consumes an entry a dormant session
            // still has coming to it.
            this.options.inbox.advance(id, entries[entries.length - 1]!.seq);
        }
        await this.drainPending();
    }

    private classify(entry: InboxEntry): void {
        const address = entry.address;
        if (address === null || this.consumers.get(address) !== undefined) {
            return;
        }
        if (this.isSelfCaused(entry, address)) {
            this.hold(address, entry, "self-caused");
            return;
        }
        if (!this.enabled) {
            this.hold(
                address,
                entry,
                this.options.subsystemEnabled === false
                    ? "subsystem-off"
                    : "not-confirmed",
            );
            return;
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
    }

    private async drainPending(): Promise<void> {
        const now = this.clock();
        for (const [address, state] of this.addresses) {
            const entry = state.pending;
            if (entry === null) {
                continue;
            }
            if (!this.maySpawn(state, now)) {
                this.hold(address, entry, "rate-limited");
                continue;
            }
            const request = this.requestFor(address, entry, state.coalesced);
            const session = await this.options.spawnSession(request);
            if (session === null) {
                this.hold(address, entry, "no-target");
                continue;
            }
            state.pending = null;
            state.coalesced = 0;
            state.lastSpawnMs = now;
            await session.recordProvenance(request.provenance);
        }
    }

    private requestFor(
        address: string,
        entry: InboxEntry,
        coalesced: number,
    ): SpawnRequest {
        const approvalMode = this.options.inheritedApprovalMode?.(address)
            ?? COLD_SPAWN_APPROVAL_MODE;
        return {
            address,
            entry,
            coalesced,
            approvalMode,
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
     * An entry a session caused can never start a session to react to it. The
     * label check covers the session's own address; the host predicate covers
     * an entry one of its agents caused under a different address.
     */
    private isSelfCaused(entry: InboxEntry, address: string): boolean {
        if (entry.session !== null && entry.session === address) {
            return true;
        }
        return this.options.causedByKnownSession?.(entry) ?? false;
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

    private constructor(path: string, confirmedAt: string | null) {
        this.path = path;
        this.confirmedAt = confirmedAt;
    }

    static open(path: string = defaultSpawnConsentPath()): SpawnConsentStore {
        return new SpawnConsentStore(path, readConfirmedAt(path));
    }

    get confirmed(): boolean {
        return this.confirmedAt !== null;
    }

    /** Call only from a surface where the user answered, not from config load. */
    confirm(at: string = new Date().toISOString()): void {
        this.confirmedAt = at;
        this.write();
    }

    revoke(): void {
        this.confirmedAt = null;
        this.write();
    }

    private write(): void {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(
            this.path,
            `${JSON.stringify({ spawn_on_event: this.confirmedAt }, null, 2)}\n`,
        );
    }
}

export function defaultSpawnConsentPath(): string {
    return join(homedir(), ".vera", "spawn-consent.json");
}

function readConfirmedAt(path: string): string | null {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }
        const value = (parsed as { spawn_on_event?: unknown }).spawn_on_event;
        return typeof value === "string" && value.length > 0 ? value : null;
    } catch {
        // An unreadable consent file is no consent, never an assumed yes.
        return null;
    }
}
