import { randomUUID } from "node:crypto";

import {
    type AttachInboxConsumerRequest,
    type InboxAdmissionCandidate,
    type InboxAdmissionDecision,
    type InboxDeliveryCoordinator,
    type InboxDeliverySession,
    type InboxNotice,
    type InboxSessionBridge,
    type RemoteInboxSession,
} from "../inbox-delivery.ts";
import type { InboxEntry, InboxEntryInput } from "../../store/inbox.ts";

type InboxCall = (method: string, args: readonly unknown[], signal?: AbortSignal) => Promise<unknown>;

interface InboxRegistration {
    readonly label: string;
    readonly session: string;
    readonly actor?: string | null;
    readonly projectRoot?: string;
    readonly requestAdmission: boolean;
    readonly initialOffset: number;
    readonly heldWakes?: readonly number[];
}

interface HostSession {
    readonly label: string;
    readonly session: InboxDeliverySession;
    readonly claim: InboxClaim;
    readonly wakes: Set<number>;
    attached: boolean;
    notifiedCount?: number;
}

interface InboxClaim {
    readonly released: Promise<void>;
    release(): void;
}

const coordinatorClaims = new WeakMap<InboxDeliveryCoordinator, Map<string, InboxClaim>>();
const coordinatorHeldWakes = new WeakMap<InboxDeliveryCoordinator, Map<string, Set<number>>>();

export class HostInboxBridge {
    private readonly sessions = new Map<string, HostSession>();
    private readonly claims: Map<string, InboxClaim>;
    private readonly heldWakes: Map<string, Set<number>>;
    private readonly stopped = new AbortController();

    constructor(
        private readonly coordinator: InboxDeliveryCoordinator,
        private readonly callback: InboxCall,
        private readonly owns: (label: string) => boolean = () => true,
    ) {
        const existing = coordinatorClaims.get(coordinator);
        this.claims = existing ?? new Map();
        if (existing === undefined) coordinatorClaims.set(coordinator, this.claims);
        const held = coordinatorHeldWakes.get(coordinator);
        this.heldWakes = held ?? new Map();
        if (held === undefined) coordinatorHeldWakes.set(coordinator, this.heldWakes);
    }

    async handle(method: string, args: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
        if (method === "append") return await this.coordinator.append(args[0] as InboxEntryInput);
        if (method === "appendAdmitted") return await this.coordinator.appendAdmitted(args[0] as InboxEntryInput);
        if (method === "appendOnce") {
            if (typeof args[0] !== "string" || typeof args[1] !== "string") throw new Error("Invalid inbox producer");
            return await this.coordinator.appendOnce(args[0], args[1], args[2] as InboxEntryInput);
        }
        const token = args[0];
        if (typeof token !== "string" || token.length === 0) throw new Error("Invalid inbox session");
        if (method === "attach") {
            const registration = registrationFrom(args[1]);
            if (this.sessions.has(token)) throw new Error("Inbox session is already attached");
            const waitSignal = signal === undefined ? this.stopped.signal : AbortSignal.any([signal, this.stopped.signal]);
            while (true) {
                waitSignal.throwIfAborted();
                const previous = this.claims.get(registration.label);
                if (previous === undefined) break;
                await waitForRelease(previous.released, waitSignal);
            }
            if (!this.owns(registration.label)) throw new Error("Inbox session is owned by another worker");
            const released = Promise.withResolvers<void>();
            const claim: InboxClaim = { released: released.promise, release: () => released.resolve() };
            const wakes = new Set<number>();
            if (registration.heldWakes !== undefined && registration.heldWakes.length > 0) {
                let held = this.heldWakes.get(registration.label);
                if (held === undefined) { held = new Set(); this.heldWakes.set(registration.label, held); }
                for (const seq of registration.heldWakes) held.add(seq);
            }
            this.claims.set(registration.label, claim);
            let entry: HostSession;
            const callback = (name: string, values: readonly unknown[] = [], callbackSignal?: AbortSignal) => {
                if (!this.owns(registration.label)) return Promise.reject(new Error("Inbox session is owned by another worker"));
                return this.callback(name, [token, ...values], callbackSignal);
            };
            let session: InboxDeliverySession;
            try {
                session = this.coordinator.attach({
                    label: registration.label,
                    session: registration.session,
                    actor: registration.actor,
                    projectRoot: registration.projectRoot,
                    initialOffset: registration.initialOffset,
                    notify: (notice) => {
                        if (this.heldWakes.has(registration.label)) {
                            if (!entry.attached || entry.notifiedCount === notice.unreadCount) return;
                            entry.notifiedCount = notice.unreadCount;
                        }
                        void callback("notify", [notice]).catch(() => {
                            if (entry.notifiedCount === notice.unreadCount) entry.notifiedCount = undefined;
                        });
                    },
                    canStartTurn: () => entry.attached,
                    canWake: (candidate) => !this.heldWakes.get(registration.label)?.has(candidate.seq),
                    startTurn: async (candidate) => {
                        wakes.add(candidate.seq);
                        await callback("start", [candidate]);
                    },
                    ...(registration.requestAdmission ? {
                        requestAdmission: async (candidate: InboxAdmissionCandidate, admissionSignal: AbortSignal) =>
                            await callback("admission", [candidate], admissionSignal) as InboxAdmissionDecision | undefined,
                        onAdmissionFailure: (candidate: InboxAdmissionCandidate) => {
                            void callback("admissionFailure", [candidate]).catch(() => {});
                        },
                    } : {}),
                    onStartFailure: (candidate) => { void callback("startFailure", [candidate]).catch(() => {}); },
                });
            } catch (error) {
                this.claims.delete(registration.label);
                claim.release();
                throw error;
            }
            entry = { label: registration.label, session, claim, wakes, attached: false };
            this.sessions.set(token, entry);
            return;
        }
        const entry = this.sessions.get(token);
        if (entry === undefined) throw new Error("Inbox session is unavailable");
        if (method !== "release" && !this.owns(entry.label)) throw new Error("Inbox session is owned by another worker");
        switch (method) {
            case "pump": this.forgetAcknowledged(entry); return await entry.session.pump();
            case "attachment": {
                if (typeof args[1] !== "boolean") throw new Error("Invalid inbox attachment");
                if (entry.attached !== args[1]) entry.notifiedCount = undefined;
                entry.attached = args[1];
                entry.session.clientAttachmentChanged(args[1]);
                return;
            }
            case "forgetWakes": entry.session.forgetWakes(); return;
            case "noteDelivered": {
                if (!Number.isSafeInteger(args[1]) || (args[1] as number) <= 0) throw new Error("Invalid inbox entry");
                await entry.session.noteDelivered(args[1] as number);
                this.forgetAcknowledged(entry);
                return;
            }
            case "acknowledgeDelivered": await entry.session.acknowledgeDelivered(); this.forgetAcknowledged(entry); return;
            case "acknowledge": {
                if (!Number.isSafeInteger(args[1]) || (args[1] as number) <= 0) throw new Error("Invalid inbox entry");
                await entry.session.acknowledge(args[1] as number);
                this.forgetAcknowledged(entry);
                return;
            }
            case "release": this.release(token, entry); return;
            default: throw new Error("Unknown inbox request");
        }
    }

    close(): void {
        this.stopped.abort();
        for (const [token, entry] of this.sessions) this.release(token, entry);
    }

    interrupt(): void {
        for (const entry of this.sessions.values()) {
            this.forgetAcknowledged(entry);
            if (entry.wakes.size === 0) continue;
            let held = this.heldWakes.get(entry.label);
            if (held === undefined) {
                held = new Set();
                this.heldWakes.set(entry.label, held);
            }
            for (const seq of entry.wakes) held.add(seq);
        }
    }

    heldFor(label: string): readonly number[] {
        return [...(this.heldWakes.get(label) ?? [])];
    }

    heldLabels(): readonly string[] {
        return [...this.heldWakes.keys()].filter((label) => this.owns(label));
    }

    private forgetAcknowledged(entry: HostSession): void {
        const offset = entry.session.consumer.offset();
        for (const seq of entry.wakes) if (seq <= offset) entry.wakes.delete(seq);
        const held = this.heldWakes.get(entry.label);
        if (held === undefined) return;
        for (const seq of held) if (seq <= offset) held.delete(seq);
        if (held.size === 0) this.heldWakes.delete(entry.label);
    }

    private release(token: string, entry: HostSession): void {
        this.sessions.delete(token);
        entry.session.release();
        if (this.claims.get(entry.label) === entry.claim) this.claims.delete(entry.label);
        entry.claim.release();
    }
}

async function waitForRelease(released: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => { reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        void released.then(resolve).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
    });
}

interface WorkerSession {
    readonly request: AttachInboxConsumerRequest;
    readonly session: InboxDeliverySession;
    pending: Promise<void>;
    active: boolean;
    attached: boolean;
    readonly wakes: Set<number>;
}

export class WorkerInboxBridge implements InboxSessionBridge {
    private readonly sessions = new Map<string, WorkerSession>();

    constructor(private readonly host: InboxCall) {}

    attach(request: AttachInboxConsumerRequest, session: InboxDeliverySession): RemoteInboxSession {
        const token = randomUUID();
        const registration: InboxRegistration = {
            label: request.label,
            session: request.session,
            actor: request.actor,
            projectRoot: request.projectRoot,
            requestAdmission: request.requestAdmission !== undefined,
            initialOffset: session.consumer.offset(),
        };
        const entry: WorkerSession = { request, session, pending: Promise.resolve(), active: true, attached: false, wakes: new Set() };
        this.sessions.set(token, entry);
        const attaching = new AbortController();
        const enqueue = (method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<void> => {
            const result = entry.pending.then(async () => { await this.host(method, [token, ...args], signal); });
            entry.pending = result.then(() => undefined, () => undefined);
            return result;
        };
        void enqueue("attach", [registration], attaching.signal).catch(() => {});
        const send = (method: string, args: readonly unknown[] = []): void => {
            if (entry.active) void enqueue(method, args).catch(() => {});
        };
        const invoke = (method: string, args: readonly unknown[] = []): Promise<void> =>
            entry.active ? enqueue(method, args) : Promise.reject(new Error("Inbox session is unavailable"));
        return {
            pump: () => entry.active ? enqueue("pump") : Promise.resolve(),
            clientAttachmentChanged: (attached) => { entry.attached = attached; send("attachment", [attached]); },
            forgetWakes: () => { entry.wakes.clear(); send("forgetWakes"); },
            noteDelivered: (seq) => invoke("noteDelivered", [seq]),
            acknowledgeDelivered: () => invoke("acknowledgeDelivered"),
            acknowledge: (seq) => invoke("acknowledge", [seq]),
            release: () => {
                if (!entry.active) return;
                entry.active = false;
                attaching.abort();
                void enqueue("release").catch(() => {}).finally(() => { this.sessions.delete(token); });
            },
        };
    }

    async append(entry: InboxEntryInput, admitted: boolean): Promise<InboxEntry> {
        return await this.host(admitted ? "appendAdmitted" : "append", [entry]) as InboxEntry;
    }

    async appendOnce(source: string, key: string, entry: InboxEntryInput): Promise<{ readonly entry: InboxEntry; readonly created: boolean }> {
        return await this.host("appendOnce", [source, key, entry]) as { readonly entry: InboxEntry; readonly created: boolean };
    }

    async handle(method: string, args: readonly unknown[], signal: AbortSignal): Promise<unknown> {
        const token = args[0];
        const entry = typeof token === "string" ? this.sessions.get(token) : undefined;
        if (entry === undefined || !entry.active) throw new Error("Inbox session is unavailable");
        const value = args[1];
        switch (method) {
            case "notify": entry.request.notify(value as InboxNotice); return;
            case "start": {
                const candidate = value as InboxAdmissionCandidate;
                if (entry.request.canStartTurn?.() !== true) throw new Error("Inbox session is not attached");
                entry.session.rememberRemoteWake(candidate);
                entry.wakes.add(candidate.seq);
                try {
                    await entry.request.startTurn?.(candidate);
                } catch (error) {
                    entry.session.forgetRemoteWake(candidate.seq);
                    entry.wakes.delete(candidate.seq);
                    throw error;
                }
                return;
            }
            case "admission": {
                const candidate = value as InboxAdmissionCandidate;
                if (entry.request.canStartTurn?.() !== true) return undefined;
                const decision = await entry.request.requestAdmission?.(candidate, signal);
                if (entry.active && !signal.aborted) entry.session.rememberRemoteAdmission(candidate, decision);
                return decision;
            }
            case "admissionFailure": entry.request.onAdmissionFailure?.(value as InboxAdmissionCandidate); return;
            case "startFailure": entry.request.onStartFailure?.(value as InboxAdmissionCandidate); return;
            default: throw new Error("Unknown inbox callback");
        }
    }

    async drain(): Promise<void> {
        await Promise.all([...this.sessions.values()].map((entry) => entry.pending));
    }

    async restore(): Promise<void> {
        for (const [token, entry] of [...this.sessions]) {
            await entry.pending;
            if (!entry.active) continue;
            const offset = entry.session.consumer.offset();
            const heldWakes = [...entry.wakes].filter((seq) => seq > offset);
            const registration: InboxRegistration = {
                label: entry.request.label, session: entry.request.session,
                actor: entry.request.actor, projectRoot: entry.request.projectRoot,
                requestAdmission: entry.request.requestAdmission !== undefined,
                initialOffset: offset, heldWakes,
            };
            await this.host("attach", [token, registration]);
            if (!entry.active) await this.host("release", [token]);
        }
    }

    async activate(): Promise<void> {
        for (const [token, entry] of [...this.sessions]) {
            if (!entry.active) continue;
            await this.host("attachment", [token, entry.attached]);
            await this.host("pump", [token]);
        }
    }
}

function registrationFrom(value: unknown): InboxRegistration {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid inbox registration");
    const data = value as Record<string, unknown>;
    if (typeof data.label !== "string" || data.label.length === 0 || typeof data.session !== "string"
        || typeof data.requestAdmission !== "boolean"
        || !Number.isSafeInteger(data.initialOffset) || (data.initialOffset as number) < 0
        || (data.heldWakes !== undefined && (!Array.isArray(data.heldWakes)
            || !data.heldWakes.every((seq) => Number.isSafeInteger(seq) && seq > 0)))
        || !(data.actor === undefined || data.actor === null || typeof data.actor === "string")
        || !(data.projectRoot === undefined || typeof data.projectRoot === "string")) {
        throw new Error("Invalid inbox registration");
    }
    return data as unknown as InboxRegistration;
}
