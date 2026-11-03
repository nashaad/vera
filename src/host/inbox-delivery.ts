import type { ConsumerHandle, ConsumerRegistry } from "./consumers.ts";
import { inboxSourceFamily } from "./inbox-admission.ts";
import type { InboxAdmissionPolicy } from "./inbox-admission.ts";
import { SOURCE_GAP_KIND } from "../watch/source.ts";
import { RETIRED_PEER_READ_KIND } from "./local-participation.ts";
import type { InboxEntry, InboxEntryInput } from "../store/inbox.ts";

export const MAX_INBOX_NOTICE_COUNT = 99;
// Waits before each retry of a start that failed; after the last one the entry is reported once.
const START_RETRY_DELAYS_MS: readonly number[] = [500, 2_000, 8_000];
export const UNCOUNTED_INBOX_KINDS: readonly string[] = [SOURCE_GAP_KIND, RETIRED_PEER_READ_KIND];

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
    // A rejection or throw is retried with backoff, then reported through onStartFailure.
    readonly startTurn?: (candidate: InboxAdmissionCandidate) => void | Promise<void>;
    readonly requestAdmission?: (
        candidate: InboxAdmissionCandidate,
        signal: AbortSignal,
    ) => Promise<InboxAdmissionDecision | undefined>;
    readonly onAdmissionFailure?: (candidate: InboxAdmissionCandidate) => void;
    readonly onStartFailure?: (candidate: InboxAdmissionCandidate) => void;
}

export class InboxDeliverySession {
    private readonly coordinator: InboxDeliveryCoordinator;
    private readonly handle: ConsumerHandle;
    private readonly notify: (notice: InboxNotice) => void;
    private readonly admission?: InboxAdmissionPolicy;
    private readonly canStartTurn: () => boolean;
    private readonly startTurn: (candidate: InboxAdmissionCandidate) => void | Promise<void>;
    private readonly requestAdmission:
        AttachInboxConsumerRequest["requestAdmission"];
    private readonly onAdmissionFailure:
        AttachInboxConsumerRequest["onAdmissionFailure"];
    private readonly onStartFailure:
        AttachInboxConsumerRequest["onStartFailure"];
    private queue: Promise<void> = Promise.resolve();
    private released = false;
    private readonly sessionFamilies = new Set<string>();
    private readonly onceEntries = new Set<number>();
    // Entries whose turn was asked for and not yet acknowledged, so a pump does not ask twice.
    private readonly woken = new Set<number>();
    private readonly startFailures = new Map<number, number>();
    private readonly reportedStartFailures = new Set<number>();
    private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
    // Bumped when the client detaches, so a start from the old attachment cannot undo the new one's marks.
    private attachmentEpoch = 0;
    private readonly lastAdmissionAttempt = new Map<string, number>();
    // Newest visible entry when a family's question was dismissed; only a later arrival asks again.
    private readonly dismissedThrough = new Map<string, number>();
    // Delivered whole while an earlier unread entry holds the cursor back; acknowledged once it is next.
    private readonly deliveredAhead = new Set<number>();
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
        this.onStartFailure = request.onStartFailure;
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
        this.clearRetries();
        this.abortPendingQuestions();
        this.handle.release();
        this.coordinator.forget(this);
    }

    clientAttachmentChanged(attached: boolean): void {
        if (attached) return;
        this.sessionFamilies.clear();
        this.onceEntries.clear();
        this.attachmentEpoch += 1;
        this.woken.clear();
        this.reportedStartFailures.clear();
        this.clearRetries();
        this.lastAdmissionAttempt.clear();
        this.dismissedThrough.clear();
        this.abortPendingQuestions();
    }

    /** Clears every woken mark, so each unread entry is asked for again at the next pump. */
    forgetWakes(): void {
        this.woken.clear();
    }

    hasAdmittedPending(): boolean {
        if (this.released || !this.canStartTurn()) return false;
        for (const entry of this.unreadEntries()) {
            if (
                !this.deliveredAhead.has(entry.seq)
                && this.isAdmitted(candidateFor(entry))
            ) {
                return true;
            }
        }
        return false;
    }

    /** The entry's text is in the conversation: acknowledge it now if it is next, else when it becomes next. */
    noteDelivered(seq: number): void {
        if (this.released) return;
        this.deliveredAhead.add(seq);
        this.acknowledgeDelivered();
    }

    /** Acknowledges the run of delivered entries now at the front. Call after every other acknowledgement. */
    acknowledgeDelivered(): void {
        if (this.released) return;
        const offset = this.handle.offset();
        for (const seq of this.deliveredAhead) {
            if (seq <= offset) this.deliveredAhead.delete(seq);
        }
        while (this.deliveredAhead.size > 0) {
            const next = this.handle.read({
                limit: 1,
                addresses: [this.handle.label],
                excludeKinds: [RETIRED_PEER_READ_KIND],
            })[0];
            if (next === undefined || !this.deliveredAhead.has(next.seq)) return;
            try {
                this.handle.acknowledge(next.seq);
            } catch {
                return;
            }
            this.deliveredAhead.delete(next.seq);
        }
    }

    isAdmittedSource(sourceFamily: string): boolean {
        return this.admission?.allows(sourceFamily) === true
            || this.sessionFamilies.has(sourceFamily);
    }

    private inspect(): void {
        if (this.released) return;
        this.forgetAcknowledged();
        const unread = this.handle.unreadStatus({
            limit: MAX_INBOX_NOTICE_COUNT,
            addresses: [this.handle.label],
            excludeKinds: UNCOUNTED_INBOX_KINDS,
        }, this.coordinator.now());
        if (unread.count === 0) return;
        this.notify({
            unreadCount: Math.min(MAX_INBOX_NOTICE_COUNT, unread.count),
        });
        // Starting a turn and asking a question both need an attached client.
        if (!this.canStartTurn()) return;

        // Only the first unadmitted entry is asked about; admitted entries behind it still start turns.
        let questionOffered = false;
        const newestSeq = unread.newestSeq ?? 0;
        for (const entry of this.unreadEntries()) {
            if (this.deliveredAhead.has(entry.seq)) continue;
            const candidate = candidateFor(entry);
            if (this.isAdmitted(candidate)) {
                this.maybeStartTurn(candidate);
                continue;
            }
            if (questionOffered) continue;
            questionOffered = true;
            this.maybeRequestAdmission(candidate, newestSeq);
        }
    }

    /** Every unread entry for this conversation, oldest first, read one window at a time. */
    private *unreadEntries(): Generator<InboxEntry> {
        let afterSeq = 0;
        while (!this.released) {
            const page = this.handle.read({
                limit: MAX_INBOX_NOTICE_COUNT,
                afterSeq,
                addresses: [this.handle.label],
                excludeKinds: UNCOUNTED_INBOX_KINDS,
            });
            yield* page;
            const last = page.at(-1);
            if (last === undefined || page.length < MAX_INBOX_NOTICE_COUNT) return;
            afterSeq = last.seq;
        }
    }

    private abortPendingQuestions(): void {
        for (const controller of this.pendingAdmissionFamilies.values()) {
            controller.abort();
        }
        this.pendingAdmissionFamilies.clear();
    }

    private newestVisibleSeq(): number {
        return this.handle.unreadStatus({
            limit: MAX_INBOX_NOTICE_COUNT,
            addresses: [this.handle.label],
            excludeKinds: UNCOUNTED_INBOX_KINDS,
        }, this.coordinator.now()).newestSeq ?? 0;
    }

    private isAdmitted(candidate: InboxAdmissionCandidate): boolean {
        return this.coordinator.isPreAdmitted(candidate.seq)
            || this.admission?.allows(candidate.sourceFamily) === true
            || this.sessionFamilies.has(candidate.sourceFamily)
            || this.onceEntries.has(candidate.seq);
    }

    private maybeStartTurn(candidate: InboxAdmissionCandidate): void {
        if (this.released || !this.canStartTurn() || this.woken.has(candidate.seq)) return;
        this.woken.add(candidate.seq);
        const epoch = this.attachmentEpoch;
        const failed = (): void => {
            if (epoch === this.attachmentEpoch) this.startFailed(candidate);
        };
        try {
            Promise.resolve(this.startTurn(candidate)).catch(failed);
        } catch {
            failed();
        }
    }

    private startFailed(candidate: InboxAdmissionCandidate): void {
        // Only this entry's mark is dropped: a later entry that did start must not start again.
        this.woken.delete(candidate.seq);
        if (this.released) return;
        const failures = (this.startFailures.get(candidate.seq) ?? 0) + 1;
        this.startFailures.set(candidate.seq, failures);
        const delay = this.coordinator.retryDelaysMs()[failures - 1];
        if (delay !== undefined) {
            const timer = setTimeout(() => {
                this.retryTimers.delete(timer);
                void this.pump();
            }, delay);
            timer.unref?.();
            this.retryTimers.add(timer);
            return;
        }
        if (this.reportedStartFailures.has(candidate.seq)) return;
        this.reportedStartFailures.add(candidate.seq);
        try {
            this.onStartFailure?.(candidate);
        } catch {
        }
    }

    private clearRetries(): void {
        for (const timer of this.retryTimers) clearTimeout(timer);
        this.retryTimers.clear();
        this.startFailures.clear();
    }

    private forgetAcknowledged(): void {
        const offset = this.handle.offset();
        for (const seq of this.woken) {
            if (seq <= offset) this.woken.delete(seq);
        }
        for (const seq of this.startFailures.keys()) {
            if (seq <= offset) this.startFailures.delete(seq);
        }
        for (const seq of this.reportedStartFailures) {
            if (seq <= offset) this.reportedStartFailures.delete(seq);
        }
    }

    private maybeRequestAdmission(
        candidate: InboxAdmissionCandidate,
        newestSeq: number,
    ): void {
        if (
            this.requestAdmission === undefined
            || !this.canStartTurn()
            || this.pendingAdmissionFamilies.has(candidate.sourceFamily)
        ) {
            return;
        }
        const previous = this.lastAdmissionAttempt.get(candidate.sourceFamily);
        if (previous !== undefined && candidate.seq <= previous) return;
        const dismissed = this.dismissedThrough.get(candidate.sourceFamily);
        if (dismissed !== undefined && newestSeq <= dismissed) return;
        this.dismissedThrough.delete(candidate.sourceFamily);
        this.lastAdmissionAttempt.set(candidate.sourceFamily, candidate.seq);
        const controller = new AbortController();
        this.pendingAdmissionFamilies.set(candidate.sourceFamily, controller);
        void this.requestAdmission(
            candidate,
            controller.signal,
        ).then(async (decision) => {
            if (decision === undefined) {
                // A dismissed question is not an answer: the next arrival visible here asks again.
                if (!controller.signal.aborted && !this.released) {
                    // Cleared here, not in finally, so an arrival pumped before finally can ask.
                    if (
                        this.pendingAdmissionFamilies.get(candidate.sourceFamily)
                        === controller
                    ) {
                        this.pendingAdmissionFamilies.delete(candidate.sourceFamily);
                    }
                    this.lastAdmissionAttempt.delete(candidate.sourceFamily);
                    this.dismissedThrough.set(
                        candidate.sourceFamily,
                        this.newestVisibleSeq(),
                    );
                }
                return;
            }
            if (!this.canStartTurn()) return;
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
    readonly retryDelaysMs?: readonly number[];
    readonly admission?: InboxAdmissionPolicy;
    readonly admissionFor?: (
        projectRoot?: string,
    ) => InboxAdmissionPolicy | undefined;
}

export class InboxDeliveryCoordinator {
    private readonly consumers: ConsumerRegistry;
    private readonly sessions = new Set<InboxDeliverySession>();
    private readonly clock: () => number;
    private readonly startRetryDelaysMs: readonly number[];
    private readonly admission?: InboxAdmissionPolicy;
    private readonly admissionFor?: InboxDeliveryOptions["admissionFor"];
    // In memory only: after a host restart an unread entry falls back to the admission prompt.
    private readonly preAdmitted = new Set<number>();

    constructor(consumers: ConsumerRegistry, options: InboxDeliveryOptions = {}) {
        this.consumers = consumers;
        this.clock = options.now ?? (() => Date.now());
        this.startRetryDelaysMs = options.retryDelaysMs ?? START_RETRY_DELAYS_MS;
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

    /** Appends an entry the host vouches for, so it starts a turn without an admission prompt. */
    async appendAdmitted(entry: InboxEntryInput): Promise<InboxEntry> {
        const stored = this.consumers.append(entry);
        this.preAdmitted.add(stored.seq);
        await this.pumpAll();
        return stored;
    }

    isPreAdmitted(seq: number): boolean {
        return this.preAdmitted.has(seq);
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

    retryDelaysMs(): readonly number[] {
        return this.startRetryDelaysMs;
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
