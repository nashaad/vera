import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ConsumerRegistry } from "./consumers.ts";
import type { Inbox, InboxEntry } from "../store/inbox.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";
import { SOURCE_GAP_KIND } from "../watch/source.ts";
import { veraProfileDirectory } from "../profile-paths.ts";

const PEER_MESSAGE_KIND = "peer.message";

export const COLD_SPAWN_APPROVAL_MODE = "ask";

export const DEFAULT_MIN_SPAWN_INTERVAL_MS = 60_000;

export const DEFAULT_MAX_ENTRIES_PER_SCAN = 100;

export const MAX_HELD_ENTRIES = 1_000;

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
    readonly address: string;
    readonly entry: InboxEntry;
    readonly coalesced: number;
    readonly approvalMode: string;
    readonly provenance: string;
}

export interface SpawnedSession {
    readonly label: string;
    recordProvenance(text: string): Promise<void>;
}

export type SpawnSessionFn = (
    request: SpawnRequest,
) => Promise<SpawnedSession | null>;

export interface SpawnGates {
    readonly subsystemEnabled: boolean;
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
    readonly subsystemEnabled: boolean;
    readonly causedByKnownSession?: (entry: InboxEntry) => boolean;
    readonly minSpawnIntervalMs?: number;
    readonly maxEntriesPerScan?: number;
    readonly now?: () => number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
}

export interface SpawnConsent {
    readonly confirmed: boolean;
}

interface ScannedEntry {
    readonly entry: InboxEntry;
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
    private readonly setTimer: (run: () => void, ms: number) => unknown;
    private readonly clearTimer: (timer: unknown) => void;
    private retryTimer: unknown = null;

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
        this.setTimer = options.setTimer
            ?? ((run, ms) => {
                const timer = setTimeout(run, ms);
                timer.unref?.();
                return timer;
            });
        this.clearTimer = options.clearTimer
            ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
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

    held(): readonly HeldEntry[] {
        return [...this.heldEntries];
    }

    heldDroppedCount(): number {
        return this.heldDropped;
    }

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
        if (this.retryTimer !== null) {
            this.clearTimer(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private scheduleRetry(delayMs: number): void {
        if (this.retryTimer !== null || this.released) {
            return;
        }
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = null;
            void this.scan();
        }, Math.max(1, delayMs));
    }

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
            this.options.inbox.advance(id, advanceTo);
        }
    }

    private classify(entry: InboxEntry): ScannedEntry {
        const address = entry.address;
        if (entry.kind === SOURCE_GAP_KIND || entry.kind === PEER_MESSAGE_KIND) {
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
            state.coalesced += 1;
        }
        return { entry, address, final: false };
    }

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
                // A held entry must not depend on another append to be seen again: rescan when this address's cooldown expires.
                this.scheduleRetry(
                    (state.lastSpawnMs ?? now) + this.minSpawnIntervalMs - now,
                );
                continue;
            }
            const request = this.requestFor(address, entry, state.coalesced);
            const session = await this.options.spawnSession(request);
            if (session === null) {
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

/** The second gate, on disk. It is a separate file from the config on purpose: loading, copying or generating configuration must not be able to turn spawning on, so the only. */
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

    get confirmed(): boolean {
        this.refresh();
        return this.confirmedAt !== null;
    }

    get confirmedAtIso(): string | null {
        this.refresh();
        return this.confirmedAt;
    }

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
        const temporary = `${this.path}.tmp-${process.pid}`;
        writeFileSync(temporary, body);
        renameSync(temporary, this.path);
    }
}

function fileStamp(path: string): string | null {
    try {
        const stats = statSync(path);
        return `${stats.size}:${stats.mtimeMs}`;
    } catch {
        return null;
    }
}

export function defaultSpawnConsentPath(): string {
    return join(veraProfileDirectory(), "spawn-consent.json");
}

function readConfirmedAt(path: string): string | null {
    let text: string;
    try {
        text = readRegularFileTextSync(path);
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
        return null;
    }
}
