import { randomUUID } from "node:crypto";

import { InteractiveAttachmentRegistry, type InteractiveAttachmentLease } from "./interactive-attachments.ts";
import type { AttachmentReleasePolicy } from "./protocol.ts";
import type { CloseAgentOutcome } from "./server.ts";

export type AttachmentTreeReader = (id: string) => readonly string[];

export interface AttachmentReleaseDecision {
    readonly remaining: number;
    readonly rootsToStop: readonly string[];
    readonly ignoredLeaseIds?: readonly string[];
}

export interface AttachmentStillAttached {
    readonly status: "attached";
    readonly remaining: number;
}

interface AttachmentLease {
    readonly agentId: string;
    readonly clientId: string;
    readonly lease: InteractiveAttachmentLease;
}

interface AttachmentCloseMembers {
    readonly members: readonly string[];
}

interface AttachmentCloseRefusal {
    readonly outcome: CloseAgentOutcome | AttachmentStillAttached;
}

type AttachmentClosePreparation = AttachmentCloseMembers | AttachmentCloseRefusal;

export interface AttachmentCoordinator {
    open(agentId: string, clientId: string): Promise<string>;
    detach(leaseId: string, agentId: string): Promise<readonly string[]>;
    abandon(leaseId: string, agentId: string): Promise<void>;
    ready(agentId: string): Promise<readonly string[]>;
    release(leaseId: string, agentId: string, clientId: string, policy: AttachmentReleasePolicy): Promise<AttachmentReleaseDecision>;
    closeIfReady(agentId: string, force?: boolean, ignoredLeaseIds?: readonly string[]): Promise<CloseAgentOutcome | AttachmentStillAttached>;
}

export class InteractiveAttachmentCoordinator implements AttachmentCoordinator {
    private readonly registry = new InteractiveAttachmentRegistry();
    private readonly leases = new Map<string, AttachmentLease>();
    private readonly closing = new Set<string>();
    private pending: Promise<void> = Promise.resolve();

    constructor(
        private readonly readTrees: () => Promise<AttachmentTreeReader>,
        private readonly closeAgent: (agentId: string) => Promise<CloseAgentOutcome>,
        private readonly treeTimeoutMs = 5_000,
    ) {}

    open(agentId: string, clientId: string): Promise<string> {
        return this.serial(() => {
            if (this.closing.has(agentId)) throw new Error("The conversation is closing.");
            const id = randomUUID();
            this.leases.set(id, { agentId, clientId, lease: this.registry.open(agentId, clientId) });
            return id;
        });
    }

    restore(id: string, agentId: string, clientId: string): Promise<void> {
        return this.serial(() => {
            const existing = this.leases.get(id);
            if (existing !== undefined) {
                if (existing.agentId !== agentId || existing.clientId !== clientId) throw new Error("Attachment lease conflicts with an existing lease.");
                return;
            }
            if (this.closing.has(agentId)) throw new Error("The conversation is closing.");
            this.leases.set(id, { agentId, clientId, lease: this.registry.open(agentId, clientId) });
        });
    }

    detach(leaseId: string, agentId: string): Promise<readonly string[]> {
        return this.serial(async () => {
            this.releaseLease(leaseId);
            return this.registry.readyDeferredStops(agentId, await this.trees());
        });
    }

    abandon(leaseId: string, agentId: string): Promise<void> {
        return this.serial(() => {
            this.releaseLease(leaseId);
            this.registry.deferStop(agentId);
        });
    }

    ready(agentId: string): Promise<readonly string[]> {
        return this.serial(async () => this.registry.readyDeferredStops(agentId, await this.trees()));
    }

    release(leaseId: string, agentId: string, clientId: string, policy: AttachmentReleasePolicy): Promise<AttachmentReleaseDecision> {
        return this.serial(async () => {
            this.releaseLease(leaseId);
            const readTree = await this.trees();
            const remaining = this.registry.clientCount(readTree(agentId), clientId);
            let rootsToStop: readonly string[] = [];
            if (policy === "keep_running") this.registry.keepRunning(agentId, readTree);
            else if (policy === "force_stop") rootsToStop = this.registry.forceStop(agentId, readTree);
            else rootsToStop = this.registry.stopIfLast(agentId, clientId, readTree).rootsToStop;
            const ignoredLeaseIds = policy === "stop_if_last" && rootsToStop.length > 0
                ? [...this.leases].flatMap(([id, lease]) => lease.clientId === clientId ? [id] : [])
                : [];
            return { remaining, rootsToStop, ...(ignoredLeaseIds.length === 0 ? {} : { ignoredLeaseIds }) };
        });
    }

    async closeIfReady(agentId: string, force = false, ignoredLeaseIds: readonly string[] = []): Promise<CloseAgentOutcome | AttachmentStillAttached> {
        const prepared = await this.serial<AttachmentClosePreparation>(async () => {
            const members = (await this.trees())(agentId);
            if (members.some((id) => this.closing.has(id))) return { outcome: { status: "busy" as const } };
            const ignored = new Set(ignoredLeaseIds);
            const clients = new Set([...this.leases].flatMap(([id, lease]) =>
                !ignored.has(id) && members.includes(lease.agentId) ? [lease.clientId] : []
            ));
            const remaining = clients.size;
            if (!force && remaining > 0) {
                this.registry.deferStop(agentId);
                return { outcome: { status: "attached" as const, remaining } };
            }
            for (const id of members) this.closing.add(id);
            return { members };
        });
        if ("outcome" in prepared) return prepared.outcome;
        try {
            return await this.closeAgent(agentId);
        } finally {
            for (const id of prepared.members) this.closing.delete(id);
        }
    }

    private async trees(): Promise<AttachmentTreeReader> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.readTrees(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Session attachment tree timed out.")), this.treeTimeoutMs);
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    private releaseLease(id: string): void {
        this.leases.get(id)?.lease.release();
        this.leases.delete(id);
    }

    private serial<T>(run: () => T | Promise<T>): Promise<T> {
        const result = this.pending.then(run);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }
}
