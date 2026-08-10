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
}

/** Owns the attachment and metadata behind the TUI's shared agent sidebar. */
export class TuiHostedSidebarAgent {
    owner: string | undefined;
    pane: TuiAgentPane<IdentifiedTuiAgentClient> | undefined;
    attachmentLifetime: TuiAgentAttachmentLifetime = "durable";
    initialApprovalMode: string | undefined;
    mention: string | undefined;
    modeLabel: string | undefined;

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
        request.signal?.throwIfAborted();
        if (
            request.replaceOwner !== true
            && this.pane === undefined
            && this.owner !== undefined
            && this.owner !== request.extensionId
        ) {
            request.client.close();
            throw new Error(`${this.owner} is using the sidebar`);
        }

        const previous = this.pane;
        const previousModeLabel = this.modeLabel;
        this.pane = undefined;
        try {
            await previous?.detach();
        } catch (error) {
            request.client.close();
            throw error;
        }
        if (request.signal?.aborted) {
            request.client.close();
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
        return previousModeLabel;
    }

    start(): void {
        this.pane?.start();
    }

    release(extensionId?: string): TuiAgentPane<IdentifiedTuiAgentClient> | undefined {
        if (extensionId !== undefined) this.requireOwner(extensionId);
        const attached = this.pane;
        this.pane = undefined;
        this.mention = undefined;
        this.modeLabel = undefined;
        this.owner = undefined;
        return attached;
    }
}
