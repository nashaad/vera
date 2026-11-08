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
}

interface MasterSession {
    readonly label: string;
    readonly session: InboxDeliverySession;
    readonly claim: InboxClaim;
    attached: boolean;
}

interface InboxClaim {
    readonly released: Promise<void>;
    release(): void;
}

const coordinatorClaims = new WeakMap<InboxDeliveryCoordinator, Map<string, InboxClaim>>();

export class MasterInboxBridge {
    private readonly sessions = new Map<string, MasterSession>();
    private readonly claims: Map<string, InboxClaim>;
    private readonly stopped = new AbortController();

    constructor(private readonly coordinator: InboxDeliveryCoordinator, private readonly callback: InboxCall) {
        const existing = coordinatorClaims.get(coordinator);
        this.claims = existing ?? new Map();
        if (existing === undefined) coordinatorClaims.set(coordinator, this.claims);
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
            const released = Promise.withResolvers<void>();
            const claim: InboxClaim = { released: released.promise, release: () => released.resolve() };
            this.claims.set(registration.label, claim);
            let entry: MasterSession;
            const callback = (name: string, values: readonly unknown[] = [], callbackSignal?: AbortSignal) =>
                this.callback(name, [token, ...values], callbackSignal);
            let session: InboxDeliverySession;
            try {
                session = this.coordinator.attach({
                    label: registration.label,
                    session: registration.session,
                    actor: registration.actor,
                    projectRoot: registration.projectRoot,
                    initialOffset: registration.initialOffset,
                    notify: (notice) => { void callback("notify", [notice]).catch(() => {}); },
                    canStartTurn: () => entry.attached,
                    startTurn: async (candidate) => { await callback("start", [candidate]); },
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
            entry = { label: registration.label, session, claim, attached: false };
            this.sessions.set(token, entry);
            return;
        }
        const entry = this.sessions.get(token);
        if (entry === undefined) throw new Error("Inbox session is unavailable");
        switch (method) {
            case "pump": return await entry.session.pump();
            case "attachment": {
                if (typeof args[1] !== "boolean") throw new Error("Invalid inbox attachment");
                entry.attached = args[1];
                entry.session.clientAttachmentChanged(args[1]);
                return;
            }
            case "forgetWakes": entry.session.forgetWakes(); return;
            case "noteDelivered": {
                if (!Number.isSafeInteger(args[1]) || (args[1] as number) <= 0) throw new Error("Invalid inbox entry");
                await entry.session.noteDelivered(args[1] as number);
                return;
            }
            case "acknowledgeDelivered": await entry.session.acknowledgeDelivered(); return;
            case "acknowledge": {
                if (!Number.isSafeInteger(args[1]) || (args[1] as number) <= 0) throw new Error("Invalid inbox entry");
                await entry.session.acknowledge(args[1] as number);
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

    private release(token: string, entry: MasterSession): void {
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
}

export class WorkerInboxBridge implements InboxSessionBridge {
    private readonly sessions = new Map<string, WorkerSession>();

    constructor(private readonly master: InboxCall) {}

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
        const entry: WorkerSession = { request, session, pending: Promise.resolve(), active: true };
        this.sessions.set(token, entry);
        const attaching = new AbortController();
        const enqueue = (method: string, args: readonly unknown[] = [], signal?: AbortSignal): Promise<void> => {
            const result = entry.pending.then(async () => { await this.master(method, [token, ...args], signal); });
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
            clientAttachmentChanged: (attached) => send("attachment", [attached]),
            forgetWakes: () => send("forgetWakes"),
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
        return await this.master(admitted ? "appendAdmitted" : "append", [entry]) as InboxEntry;
    }

    async appendOnce(source: string, key: string, entry: InboxEntryInput): Promise<{ readonly entry: InboxEntry; readonly created: boolean }> {
        return await this.master("appendOnce", [source, key, entry]) as { readonly entry: InboxEntry; readonly created: boolean };
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
                try {
                    await entry.request.startTurn?.(candidate);
                } catch (error) {
                    entry.session.forgetRemoteWake(candidate.seq);
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
}

function registrationFrom(value: unknown): InboxRegistration {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid inbox registration");
    const data = value as Record<string, unknown>;
    if (typeof data.label !== "string" || data.label.length === 0 || typeof data.session !== "string"
        || typeof data.requestAdmission !== "boolean"
        || !Number.isSafeInteger(data.initialOffset) || (data.initialOffset as number) < 0
        || !(data.actor === undefined || data.actor === null || typeof data.actor === "string")
        || !(data.projectRoot === undefined || typeof data.projectRoot === "string")) {
        throw new Error("Invalid inbox registration");
    }
    return data as unknown as InboxRegistration;
}
