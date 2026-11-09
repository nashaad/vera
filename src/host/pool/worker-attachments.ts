import type { AttachmentCoordinator } from "../attachment-coordinator.ts";
import type { ControlChannel } from "./control.ts";
import { remoteAttachments } from "./remote-routing.ts";

interface WorkerAttachment {
    readonly agentId: string;
    readonly clientId: string;
}

export class WorkerAttachments implements AttachmentCoordinator {
    private readonly remote: AttachmentCoordinator;
    private readonly leases = new Map<string, WorkerAttachment>();

    constructor(private readonly peer: ControlChannel) {
        this.remote = remoteAttachments(peer);
    }

    async open(agentId: string, clientId: string): Promise<string> {
        const id = await this.remote.open(agentId, clientId);
        this.leases.set(id, { agentId, clientId });
        return id;
    }

    detach(id: string, agentId: string): Promise<readonly string[]> {
        this.leases.delete(id);
        return this.remote.detach(id, agentId);
    }

    abandon(id: string, agentId: string): Promise<void> {
        this.leases.delete(id);
        return this.remote.abandon(id, agentId);
    }

    ready(agentId: string): Promise<readonly string[]> { return this.remote.ready(agentId); }

    release(id: string, agentId: string, clientId: string, policy: Parameters<AttachmentCoordinator["release"]>[3]) {
        this.leases.delete(id);
        return this.remote.release(id, agentId, clientId, policy);
    }

    closeIfReady(agentId: string, force?: boolean, ignoredLeaseIds?: readonly string[]) {
        return this.remote.closeIfReady(agentId, force, ignoredLeaseIds);
    }

    async restore(): Promise<void> {
        for (const [id, entry] of [...this.leases]) {
            await this.peer.request("attachment.restore", [id, entry.agentId, entry.clientId]);
            if (!this.leases.has(id)) await this.remote.abandon(id, entry.agentId);
        }
    }
}
