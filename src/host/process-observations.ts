import { createHash } from "node:crypto";

import type { ExtensionRegistry } from "../extensions/registry.ts";
import type { Inbox, InboxEntry } from "../store/inbox.ts";
import {
    normalizeObservationSettlement,
    validateObservationStart,
    type ProcessObservation,
} from "../store/process-observations.ts";
import type {
    ManagedProcessObservationSettlement,
    ManagedProcessObservationStart,
} from "../tools/process-runtime.ts";
import type { InboxDeliveryCoordinator } from "./inbox-delivery.ts";
import { cleanupObservedProcess, observationExecutorAlive } from "./process-observation-recovery.ts";

const PRODUCER = "vera.process-observation";
const PAGE_SIZE = 50;

type TerminalOutcome = "settled" | "interrupted";

interface ObservationProof {
    readonly executor: string;
    readonly owner: string;
    readonly identity: string;
    readonly outcome: TerminalOutcome;
    readonly fingerprint: string;
}

export interface ObservationReplayResult {
    readonly delivered: number;
    readonly deferred: number;
    readonly failed: number;
}

export class ProcessObservationCoordinator {
    constructor(
        private readonly inbox: Inbox,
        private readonly delivery: InboxDeliveryCoordinator,
        private readonly extensions: Pick<ExtensionRegistry, "formatProcessOutcome">,
    ) {}

    start(executor: string, start: ManagedProcessObservationStart): void {
        validateObservationStart(executor, start);
        const previous = this.inbox.producerEntry(PRODUCER, start.processId);
        if (previous !== undefined) {
            const proof = this.requireProof(previous, start.processId);
            if (proof.executor !== executor || proof.owner !== start.ownerId
                || proof.identity !== identityFingerprint(executor, start)) {
                throw new Error("Process observation identity does not match");
            }
            return;
        }
        this.inbox.processObservations.register(executor, start);
    }

    /** A retransmission is authorized by the exact host-recorded identity, even after routing changes. */
    acceptsPreviousStart(executor: string, start: ManagedProcessObservationStart): boolean {
        validateObservationStart(executor, start);
        const recorded = this.inbox.processObservations.get(start.processId);
        if (recorded !== undefined) {
            return identityFingerprint(executor, start) === identityFingerprint(recorded.executorId, recorded);
        }
        const previous = this.inbox.producerEntry(PRODUCER, start.processId);
        if (previous === undefined) return false;
        const proof = this.requireProof(previous, start.processId);
        return proof.executor === executor && proof.owner === start.ownerId
            && proof.identity === identityFingerprint(executor, start);
    }

    async settle(executor: string, settlement: ManagedProcessObservationSettlement): Promise<void> {
        validateObservationStart(executor, settlement);
        const normalized = normalizeObservationSettlement(settlement);
        const previous = this.inbox.producerEntry(PRODUCER, settlement.processId);
        if (previous !== undefined) {
            const proof = this.requireProof(previous, settlement.processId);
            if (proof.executor !== executor || proof.owner !== settlement.ownerId
                || proof.identity !== identityFingerprint(executor, settlement)
                || proof.outcome !== "settled"
                || proof.fingerprint !== settlementFingerprint(settlement, normalized)) {
                throw new Error("Process settlement does not match the recorded outcome");
            }
            const retained = this.inbox.processObservations.get(settlement.processId);
            if (retained !== undefined) this.removeDelivered(retained, proof);
            await this.delivery.pumpAll();
            return;
        }
        const observation = this.inbox.processObservations.settle(executor, settlement);
        await this.deliver(observation);
    }

    /** Interrupt only a particular lost child execution, not other work owned by its host. */
    async interruptObservation(executor: string, start: ManagedProcessObservationStart): Promise<void> {
        validateObservationStart(executor, start);
        const recorded = this.inbox.processObservations.get(start.processId);
        if (recorded === undefined) {
            if (this.inbox.producerEntry(PRODUCER, start.processId) !== undefined
                && !this.acceptsPreviousStart(executor, start)) {
                throw new Error("Conflicting process observation interruption");
            }
            return;
        }
        if (!this.acceptsPreviousStart(executor, start)) throw new Error("Conflicting process observation interruption");
        if (recorded.outcome !== "running") {
            await this.deliver(recorded);
            return;
        }
        await cleanupObservedProcess(recorded);
        const current = this.inbox.processObservations.get(start.processId);
        if (current === undefined) {
            if (!this.acceptsPreviousStart(executor, start)) throw new Error("Conflicting process observation interruption");
            return;
        }
        if (!this.acceptsPreviousStart(executor, start)) throw new Error("Conflicting process observation interruption");
        const interrupted = current.outcome === "running"
            ? this.inbox.processObservations.interrupt(executor, current.ownerId, current.processId)
            : current;
        await this.deliver(interrupted);
    }

    async interruptExecutor(executor: string, onDelivered?: (ownerId: string) => void): Promise<ObservationReplayResult> {
        const result = { delivered: 0, deferred: 0, failed: 0 };
        let after = "";
        while (true) {
            const page = this.inbox.processObservations.running(executor, after, PAGE_SIZE);
            if (page.length === 0) return result;
            for (const running of page) {
                after = running.processId;
                try {
                    await cleanupObservedProcess(running);
                    const interrupted = this.inbox.processObservations.interrupt(executor, running.ownerId, running.processId);
                    if (await this.deliver(interrupted)) {
                        result.delivered += 1;
                        onDelivered?.(interrupted.ownerId);
                    } else result.deferred += 1;
                } catch {
                    result.failed += 1;
                }
            }
        }
    }

    /** Reconcile old executors without mistaking an adopted or unverifiable worker for a dead one. */
    async recover(localExecutor: string): Promise<ObservationReplayResult> {
        const result = { delivered: 0, deferred: 0, failed: 0 };
        let after = "";
        while (true) {
            const page = this.inbox.processObservations.allRunning(after, PAGE_SIZE);
            if (page.length === 0) break;
            const live = new Map<string, boolean>();
            for (const running of page) {
                after = running.processId;
                let alive = live.get(running.executorId);
                if (alive === undefined) {
                    alive = observationExecutorAlive(running.executorId, localExecutor);
                    live.set(running.executorId, alive);
                }
                if (alive) continue;
                try {
                    await cleanupObservedProcess(running);
                    const interrupted = this.inbox.processObservations.interrupt(
                        running.executorId, running.ownerId, running.processId,
                    );
                    if (await this.deliver(interrupted)) result.delivered += 1;
                    else result.deferred += 1;
                } catch {
                    result.failed += 1;
                }
            }
        }
        const replay = await this.replayPending();
        result.delivered += replay.delivered;
        result.deferred += replay.deferred;
        result.failed += replay.failed;
        return result;
    }

    async replayPending(): Promise<ObservationReplayResult> {
        const result = { delivered: 0, deferred: 0, failed: 0 };
        let after = "";
        while (true) {
            const page = this.inbox.processObservations.pending(after, PAGE_SIZE);
            if (page.length === 0) return result;
            for (const observation of page) {
                after = observation.processId;
                try {
                    if (await this.deliver(observation)) result.delivered += 1;
                    else result.deferred += 1;
                } catch {
                    result.failed += 1;
                }
            }
        }
    }

    private async deliver(observation: ProcessObservation): Promise<boolean> {
        if (observation.outcome === "running") throw new Error("A running process cannot be delivered");
        const proof = proofFor(observation);
        const previous = this.inbox.producerEntry(PRODUCER, observation.processId);
        if (previous !== undefined) {
            this.removeDelivered(observation, this.requireProof(previous, observation.processId));
            await this.delivery.pumpAll();
            return true;
        }
        const text = await this.extensions.formatProcessOutcome(observation.extensionId, {
            processId: observation.processId,
            description: observation.description,
            pid: observation.pid,
            startedAt: observation.startedAt,
            outcome: observation.outcome,
            ...(observation.elapsedMs === undefined ? {} : { elapsedMs: observation.elapsedMs }),
            ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
            ...(observation.outputTail === undefined ? {} : { outputTail: observation.outputTail }),
            ...(observation.outputTruncated === undefined ? {} : { outputTruncated: observation.outputTruncated }),
        });
        if (text === undefined) return false;
        const stored = await this.delivery.appendOnceAdmitted(PRODUCER, observation.processId, {
            source: sourceFor(observation.processId),
            kind: kindFor(observation.outcome),
            address: observation.ownerId,
            payload: JSON.stringify({ type: "host_notice", version: 1, text, proof }),
        });
        this.removeDelivered(observation, this.requireProof(stored.entry, observation.processId));
        return true;
    }

    private removeDelivered(observation: ProcessObservation, proof: ObservationProof): void {
        const expected = proofFor(observation);
        if (JSON.stringify(proof) !== JSON.stringify(expected)) {
            throw new Error("Process observation proof does not match");
        }
        if (this.inbox.processObservations.get(observation.processId) !== undefined) {
            this.inbox.processObservations.removeTerminal(observation.executorId, observation.ownerId, observation.processId);
        }
    }

    private requireProof(entry: InboxEntry, processId: string): ObservationProof {
        let value: unknown;
        try { value = JSON.parse(entry.payload); } catch { throw new Error("Invalid process observation proof"); }
        if (typeof value !== "object" || value === null || !("proof" in value)) {
            throw new Error("Invalid process observation proof");
        }
        const proof = value.proof;
        if (typeof proof !== "object" || proof === null
            || !("executor" in proof) || typeof proof.executor !== "string"
            || !("owner" in proof) || typeof proof.owner !== "string"
            || !("identity" in proof) || typeof proof.identity !== "string"
            || !("outcome" in proof) || (proof.outcome !== "settled" && proof.outcome !== "interrupted")
            || !("fingerprint" in proof) || typeof proof.fingerprint !== "string"
            || entry.source !== sourceFor(processId) || entry.kind !== kindFor(proof.outcome)
            || entry.address !== proof.owner || !this.inbox.isDurablyAdmitted(entry.seq)) {
            throw new Error("Invalid process observation proof");
        }
        return {
            executor: proof.executor, owner: proof.owner, identity: proof.identity,
            outcome: proof.outcome, fingerprint: proof.fingerprint,
        };
    }
}

function sourceFor(processId: string): string {
    return `vera/process/${processId}`;
}

function kindFor(outcome: TerminalOutcome): string {
    return outcome === "settled" ? "process.exited" : "process.interrupted";
}

function hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function identityFingerprint(executor: string, start: ManagedProcessObservationStart): string {
    return hash([executor, start.ownerId, start.processId, start.extensionId, start.description, start.pid, start.startedAt]);
}

function settlementFingerprint(
    settlement: Pick<ManagedProcessObservationSettlement, "elapsedMs" | "exitCode">,
    normalized: { readonly outputTail: string; readonly outputTruncated: boolean },
): string {
    return hash(["settled", settlement.elapsedMs, settlement.exitCode ?? null, normalized.outputTail, normalized.outputTruncated]);
}

function proofFor(observation: ProcessObservation): ObservationProof {
    if (observation.outcome === "running") throw new Error("A running process cannot be delivered");
    const fingerprint = observation.outcome === "interrupted"
        ? hash(["interrupted"])
        : settlementFingerprint({ elapsedMs: observation.elapsedMs!, exitCode: observation.exitCode }, {
            outputTail: observation.outputTail!, outputTruncated: observation.outputTruncated!,
        });
    return {
        executor: observation.executorId,
        owner: observation.ownerId,
        identity: identityFingerprint(observation.executorId, observation),
        outcome: observation.outcome,
        fingerprint,
    };
}
