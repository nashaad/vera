import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { IdentifiedTuiAgentClient } from "./agent-client.ts";
import { TuiAgentPane } from "./agent-pane.ts";

export type TuiAgentAttachmentLifetime = "ephemeral" | "durable";

export interface TuiHostedSidebarAgentOptions {
    onUpdate(
        update: AgentUpdate,
        pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    ): void;
    onFailure(
        error: Error,
        pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    ): void;
}

export interface TuiHostedSidebarAdoption {
    readonly extensionId: string;
    readonly client: IdentifiedTuiAgentClient;
    readonly replaceOwner?: boolean;
    readonly mention?: string;
    readonly attachmentLifetime?: TuiAgentAttachmentLifetime;
    readonly initialApprovalMode?: string;
    readonly statusLabel?: string;
    readonly signal?: AbortSignal;
    readonly activate?: (
        pane: TuiAgentPane<IdentifiedTuiAgentClient>,
        previousModeLabel: string | undefined,
    ) => void;
}

/** Owns the attachment and metadata behind the TUI's shared agent sidebar. */
export class TuiHostedSidebarAgent {
    owner: string | undefined;
    pane: TuiAgentPane<IdentifiedTuiAgentClient> | undefined;
    attachmentLifetime: TuiAgentAttachmentLifetime = "durable";
    initialApprovalMode: string | undefined;
    mention: string | undefined;
    modeLabel: string | undefined;
    private adoptionTail: Promise<void> = Promise.resolve();
    private revision = 0;
    private readonly pendingClients = new Set<IdentifiedTuiAgentClient>();
    private readonly closedClients = new WeakSet<IdentifiedTuiAgentClient>();

    constructor(private readonly options: TuiHostedSidebarAgentOptions) {}

    claim(extensionId: string): void {
        if (this.owner !== undefined && this.owner !== extensionId) {
            throw new Error(`${this.owner} is using the sidebar`);
        }
        this.owner = extensionId;
    }

    requireOwner(extensionId: string): void {
        if (this.owner !== extensionId) {
            throw new Error(`${extensionId} does not own the sidebar`);
        }
    }

    async adopt(request: TuiHostedSidebarAdoption): Promise<string | undefined> {
        if (request.signal?.aborted) {
            this.closeClient(request.client);
            throw request.signal.reason;
        }
        for (const pending of this.pendingClients) this.closeClient(pending);
        this.pendingClients.add(request.client);
        const revision = ++this.revision;
        const abort = (): void => this.closeClient(request.client);
        request.signal?.addEventListener("abort", abort, { once: true });
        const result = this.adoptionTail.then(() =>
            this.adoptCurrent(request, revision)
        );
        this.adoptionTail = result.then(() => undefined, () => undefined);
        return result.finally(() => {
            request.signal?.removeEventListener("abort", abort);
            this.pendingClients.delete(request.client);
        });
    }

    private async adoptCurrent(
        request: TuiHostedSidebarAdoption,
        revision: number,
    ): Promise<string | undefined> {
        if (revision !== this.revision) {
            this.closeClient(request.client);
            throw new Error("Sidebar agent adoption was superseded");
        }
        if (request.signal?.aborted) {
            this.closeClient(request.client);
            throw request.signal.reason;
        }
        if (
            request.replaceOwner !== true
            && this.pane === undefined
            && this.owner !== undefined
            && this.owner !== request.extensionId
        ) {
            this.closeClient(request.client);
            throw new Error(`${this.owner} is using the sidebar`);
        }

        const previous = this.pane;
        const previousModeLabel = this.modeLabel;
        const previousAttachmentLifetime = this.attachmentLifetime;
        const previousInitialApprovalMode = this.initialApprovalMode;
        this.pane = undefined;
        try {
            await previous?.detach();
        } catch (error) {
            this.closeClient(request.client);
            throw error;
        }
        if (revision !== this.revision) {
            this.closeClient(request.client);
            throw new Error("Sidebar agent adoption was superseded");
        }
        if (request.signal?.aborted) {
            this.closeClient(request.client);
            throw request.signal.reason;
        }

        this.owner = request.extensionId;
        const attached = new TuiAgentPane({
            client: request.client,
            onUpdate: this.options.onUpdate,
            onFailure: this.options.onFailure,
        });
        this.pane = attached;
        this.attachmentLifetime = request.attachmentLifetime ?? "durable";
        this.initialApprovalMode = request.initialApprovalMode
            ?? this.initialApprovalMode;
        this.mention = request.mention ?? attached.agentId;
        this.modeLabel = request.statusLabel;
        try {
            request.activate?.(attached, previousModeLabel);
        } catch (error) {
            if (this.pane === attached) {
                this.pane = undefined;
                this.mention = undefined;
                this.modeLabel = undefined;
                this.owner = undefined;
                this.attachmentLifetime = previousAttachmentLifetime;
                this.initialApprovalMode = previousInitialApprovalMode;
            }
            this.closeClient(request.client);
            throw error;
        }
        return previousModeLabel;
    }

    start(): void {
        this.pane?.start();
    }

    release(extensionId?: string): TuiAgentPane<IdentifiedTuiAgentClient> | undefined {
        if (extensionId !== undefined) this.requireOwner(extensionId);
        this.revision += 1;
        for (const pending of this.pendingClients) this.closeClient(pending);
        this.pendingClients.clear();
        const attached = this.pane;
        this.pane = undefined;
        this.mention = undefined;
        this.modeLabel = undefined;
        this.owner = undefined;
        return attached;
    }

    private closeClient(client: IdentifiedTuiAgentClient): void {
        if (this.closedClients.has(client)) return;
        this.closedClients.add(client);
        client.close();
    }
}
