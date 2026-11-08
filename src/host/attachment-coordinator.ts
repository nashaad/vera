import { randomUUID } from "node:crypto";

import { InteractiveAttachmentRegistry, type InteractiveAttachmentLease } from "./interactive-attachments.ts";
import type { AttachmentReleasePolicy } from "./protocol.ts";

export type AttachmentTreeReader = (id: string) => readonly string[];

export interface AttachmentReleaseDecision {
    readonly remaining: number;
    readonly rootsToStop: readonly string[];
}

export interface AttachmentCoordinator {
    open(agentId: string, clientId: string): Promise<string>;
    detach(leaseId: string, agentId: string): Promise<readonly string[]>;
    abandon(leaseId: string, agentId: string): Promise<void>;
    ready(agentId: string): Promise<readonly string[]>;
    release(leaseId: string, agentId: string, clientId: string, policy: AttachmentReleasePolicy): Promise<AttachmentReleaseDecision>;
}

export class InteractiveAttachmentCoordinator implements AttachmentCoordinator {
    private readonly registry = new InteractiveAttachmentRegistry();
    private readonly leases = new Map<string, InteractiveAttachmentLease>();
    private pending: Promise<void> = Promise.resolve();

    constructor(private readonly readTrees: () => Promise<AttachmentTreeReader>) {}

    open(agentId: string, clientId: string): Promise<string> {
        return this.serial(() => {
            const id = randomUUID();
            this.leases.set(id, this.registry.open(agentId, clientId));
            return id;
        });
    }

    detach(leaseId: string, agentId: string): Promise<readonly string[]> {
        return this.serial(async () => {
            this.releaseLease(leaseId);
            return this.registry.readyDeferredStops(agentId, await this.readTrees());
        });
    }

    abandon(leaseId: string, agentId: string): Promise<void> {
        return this.serial(() => {
            this.releaseLease(leaseId);
            this.registry.deferStop(agentId);
        });
    }

    ready(agentId: string): Promise<readonly string[]> {
        return this.serial(async () => this.registry.readyDeferredStops(agentId, await this.readTrees()));
    }

    release(leaseId: string, agentId: string, clientId: string, policy: AttachmentReleasePolicy): Promise<AttachmentReleaseDecision> {
        return this.serial(async () => {
            this.releaseLease(leaseId);
            const readTree = await this.readTrees();
            const remaining = this.registry.clientCount(readTree(agentId), clientId);
            let rootsToStop: readonly string[] = [];
            if (policy === "keep_running") this.registry.keepRunning(agentId, readTree);
            else if (policy === "force_stop") rootsToStop = this.registry.forceStop(agentId, readTree);
            else rootsToStop = this.registry.stopIfLast(agentId, clientId, readTree).rootsToStop;
            return { remaining, rootsToStop };
        });
    }

    private releaseLease(id: string): void {
        this.leases.get(id)?.release();
        this.leases.delete(id);
    }

    private serial<T>(run: () => T | Promise<T>): Promise<T> {
        const result = this.pending.then(run);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }
}
