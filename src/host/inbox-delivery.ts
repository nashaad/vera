import type { ConsumerHandle, ConsumerRegistry } from "./consumers.ts";
import { inboxSourceFamily } from "./inbox-admission.ts";
import type { InboxAdmissionPolicy } from "./inbox-admission.ts";
import { SOURCE_GAP_KIND } from "../watch/source.ts";
import type { InboxEntry, InboxEntryInput } from "../store/inbox.ts";

export const MAX_INBOX_NOTICE_COUNT = 99;

export interface InboxNotice {
    readonly unreadCount: number;
}

export interface InboxAdmissionCandidate {
    readonly seq: number;
    readonly source: string;
    readonly kind: string;
    readonly sourceFamily: string;
    readonly ts: string;
}

export type InboxAdmissionDecision =
    | { readonly mode: "once" }
    | { readonly mode: "session" }
    | {
        readonly mode: "always";
        readonly scope: "user" | "project";
    };

export interface AttachInboxConsumerRequest {
    readonly label: string;
    readonly actor?: string | null;
    readonly session: string;
    readonly projectRoot?: string;
    readonly notify: (notice: InboxNotice) => void;
    readonly canStartTurn?: () => boolean;
    readonly startTurn?: () => void;
    readonly requestAdmission?: (
        candidate: InboxAdmissionCandidate,
        signal: AbortSignal,
    ) => Promise<InboxAdmissionDecision | undefined>;
    readonly onAdmissionFailure?: (candidate: InboxAdmissionCandidate) => void;
}

export class InboxDeliverySession {
    private readonly coordinator: InboxDeliveryCoordinator;
    private readonly handle: ConsumerHandle;
    private readonly notify: (notice: InboxNotice) => void;
    private readonly admission?: InboxAdmissionPolicy;
    private readonly canStartTurn: () => boolean;
    private readonly startTurn: () => void;
    private readonly requestAdmission:
        AttachInboxConsumerRequest["requestAdmission"];
    private readonly onAdmissionFailure:
        AttachInboxConsumerRequest["onAdmissionFailure"];
    private queue: Promise<void> = Promise.resolve();
    private released = false;
    private readonly sessionFamilies = new Set<string>();
    private readonly onceEntries = new Set<number>();
    private readonly lastWoken = new Map<string, number>();
    private readonly lastAdmissionAttempt = new Map<string, number>();
    private readonly pendingAdmissionFamilies = new Map<
        string,
        AbortController
    >();

    constructor(
        coordinator: InboxDeliveryCoordinator,
        handle: ConsumerHandle,
        request: AttachInboxConsumerRequest,
        admission?: InboxAdmissionPolicy,
    ) {
        this.coordinator = coordinator;
        this.handle = handle;
        this.notify = request.notify;
        this.admission = admission;
        this.canStartTurn = request.canStartTurn ?? (() => false);
        this.startTurn = request.startTurn ?? (() => undefined);
        this.requestAdmission = request.requestAdmission;
        this.onAdmissionFailure = request.onAdmissionFailure;
    }

    get consumer(): ConsumerHandle {
        return this.handle;
    }

    pump(): Promise<void> {
        if (this.released) return Promise.resolve();
        const next = this.queue.then(() => this.inspect());
        this.queue = next.then(() => undefined, () => undefined);
        return this.queue;
    }

    release(): void {
        if (this.released) return;
        this.released = true;
        this.handle.release();
        this.coordinator.forget(this);
    }

    clientAttachmentChanged(attached: boolean): void {
        if (attached) return;
        this.sessionFamilies.clear();
        this.onceEntries.clear();
        this.lastWoken.clear();
        this.lastAdmissionAttempt.clear();
        for (const controller of this.pendingAdmissionFamilies.values()) {
            controller.abort();
        }
        this.pendingAdmissionFamilies.clear();
    }

    hasAdmittedPending(): boolean {
        if (this.released || !this.canStartTurn()) return false;
        const entries = this.handle.read({
            limit: MAX_INBOX_NOTICE_COUNT,
            addresses: [this.handle.label],
            excludeKinds: [SOURCE_GAP_KIND],
        });
        for (const entry of entries) {
            const candidate = candidateFor(entry);
            if (this.isAdmitted(candidate)) return true;
            return false;
        }
        return false;
    }

    isAdmittedSource(sourceFamily: string): boolean {
        return this.admission?.allows(sourceFamily) === true
            || this.sessionFamilies.has(sourceFamily);
    }

    private inspect(): void {
        if (this.released) return;
        const unread = this.handle.unreadStatus({
            limit: MAX_INBOX_NOTICE_COUNT,
            addresses: [this.handle.label],
            excludeKinds: [SOURCE_GAP_KIND],
        }, this.coordinator.now());
        if (unread.count === 0) return;
        this.notify({
            unreadCount: Math.min(MAX_INBOX_NOTICE_COUNT, unread.count),
        });

        const entries = this.handle.read({
            limit: MAX_INBOX_NOTICE_COUNT,
            addresses: [this.handle.label],
            excludeKinds: [SOURCE_GAP_KIND],
        });
        for (const entry of entries) {
            const candidate = candidateFor(entry);
            const admitted = this.isAdmitted(candidate);
            if (admitted) {
                this.maybeStartTurn(candidate);
                continue;
            }
            this.maybeRequestAdmission(candidate);
            break;
        }
    }

    private isAdmitted(candidate: InboxAdmissionCandidate): boolean {
        return this.admission?.allows(candidate.sourceFamily) === true
            || this.sessionFamilies.has(candidate.sourceFamily)
            || this.onceEntries.has(candidate.seq);
    }

    private maybeStartTurn(candidate: InboxAdmissionCandidate): void {
        if (!this.canStartTurn()) return;
        const previous = this.lastWoken.get(candidate.sourceFamily) ?? 0;
        if (candidate.seq <= previous) return;
        this.lastWoken.set(candidate.sourceFamily, candidate.seq);
        try {
            this.startTurn();
        } catch {
            this.lastWoken.delete(candidate.sourceFamily);
        }
    }

    private maybeRequestAdmission(candidate: InboxAdmissionCandidate): void {
        if (
            this.requestAdmission === undefined
            || !this.canStartTurn()
            || this.pendingAdmissionFamilies.has(candidate.sourceFamily)
        ) {
            return;
        }
        const previous = this.lastAdmissionAttempt.get(candidate.sourceFamily);
        if (previous !== undefined && candidate.seq <= previous) return;
        this.lastAdmissionAttempt.set(candidate.sourceFamily, candidate.seq);
        const controller = new AbortController();
        this.pendingAdmissionFamilies.set(candidate.sourceFamily, controller);
        void this.requestAdmission(
            candidate,
            controller.signal,
        ).then(async (decision) => {
            if (decision === undefined || !this.canStartTurn()) return;
            if (decision.mode === "session") {
                this.sessionFamilies.add(candidate.sourceFamily);
            } else if (decision.mode === "once") {
                this.onceEntries.add(candidate.seq);
            } else {
                if (this.admission === undefined) {
                    throw new Error("Inbox admission is unavailable");
                }
                await this.admission.remember(
                    candidate.sourceFamily,
                    decision.scope,
                );
            }
            this.maybeStartTurn(candidate);
        }).catch(() => {
            this.lastAdmissionAttempt.delete(candidate.sourceFamily);
            try {
                this.onAdmissionFailure?.(candidate);
            } catch {
            }
        }).finally(() => {
            if (
                this.pendingAdmissionFamilies.get(candidate.sourceFamily)
                === controller
            ) {
                this.pendingAdmissionFamilies.delete(candidate.sourceFamily);
            }
        });
    }
}

export interface InboxDeliveryOptions {
    readonly now?: () => number;
    readonly admission?: InboxAdmissionPolicy;
    readonly admissionFor?: (
        projectRoot?: string,
    ) => InboxAdmissionPolicy | undefined;
}

export class InboxDeliveryCoordinator {
    private readonly consumers: ConsumerRegistry;
    private readonly sessions = new Set<InboxDeliverySession>();
    private readonly clock: () => number;
    private readonly admission?: InboxAdmissionPolicy;
    private readonly admissionFor?: InboxDeliveryOptions["admissionFor"];

    constructor(consumers: ConsumerRegistry, options: InboxDeliveryOptions = {}) {
        this.consumers = consumers;
        this.clock = options.now ?? (() => Date.now());
        this.admission = options.admission;
        this.admissionFor = options.admissionFor;
    }

    attach(request: AttachInboxConsumerRequest): InboxDeliverySession {
        const handle = this.consumers.hello({
            label: request.label,
            selfEcho: {
                actor: request.actor ?? null,
                session: request.session,
            },
        });
        const session = new InboxDeliverySession(
            this,
            handle,
            request,
            this.admissionFor?.(request.projectRoot) ?? this.admission,
        );
        this.sessions.add(session);
        return session;
    }

    async pumpAll(): Promise<void> {
        await Promise.all([...this.sessions].map((session) => session.pump()));
    }

    async append(entry: InboxEntryInput): Promise<InboxEntry> {
        const stored = this.consumers.append(entry);
        await this.pumpAll();
        return stored;
    }

    async appendOnce(
        source: string,
        key: string,
        entry: InboxEntryInput,
    ): Promise<{ readonly entry: InboxEntry; readonly created: boolean }> {
        const stored = this.consumers.appendOnce(source, key, entry);
        if (stored.created) await this.pumpAll();
        return stored;
    }

    admissionAllows(sourceFamily: string): boolean {
        return this.admission?.allows(sourceFamily) ?? false;
    }

    hasAdmissionPath(): boolean {
        return this.admission !== undefined || this.admissionFor !== undefined;
    }

    rememberAdmission(
        sourceFamily: string,
        scope: "user" | "project",
    ): Promise<void> {
        return this.admission?.remember(sourceFamily, scope)
            ?? Promise.reject(new Error("Inbox admission is unavailable"));
    }

    admissionPolicy(): InboxAdmissionPolicy | undefined {
        return this.admission;
    }

    entry(seq: number): InboxEntry | undefined {
        return this.consumers.entry(seq);
    }

    close(): void {
        for (const session of [...this.sessions]) session.release();
    }

    now(): number {
        return this.clock();
    }

    forget(session: InboxDeliverySession): void {
        this.sessions.delete(session);
    }
}

function candidateFor(entry: InboxEntry): InboxAdmissionCandidate {
    return {
        seq: entry.seq,
        source: entry.source,
        kind: entry.kind,
        sourceFamily: inboxSourceFamily(entry),
        ts: entry.ts,
    };
}
