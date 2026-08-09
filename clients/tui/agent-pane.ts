import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { TuiAgentAttachment } from "./agent-attachments.ts";
import { TuiAgentPaneState } from "./agent-pane-state.ts";

export interface TuiAgentPaneClient {
    readonly agentId: string;
    receive(signal?: AbortSignal): Promise<AgentUpdate>;
    detach(): Promise<void>;
    close(): void;
}

export interface TuiAgentPaneOptions<Client extends TuiAgentPaneClient> {
    readonly client: Client;
    readonly onUpdate?: (
        update: AgentUpdate,
        pane: TuiAgentPane<Client>,
    ) => void;
    readonly onFailure?: (error: Error, pane: TuiAgentPane<Client>) => void;
}

/** One attachment, its presentation state, and its independent update pump. */
export class TuiAgentPane<Client extends TuiAgentPaneClient>
    implements TuiAgentAttachment {
    readonly client: Client;
    readonly state = new TuiAgentPaneState();
    private readonly onUpdate: TuiAgentPaneOptions<Client>["onUpdate"];
    private readonly onFailure: TuiAgentPaneOptions<Client>["onFailure"];
    private readonly controller = new AbortController();
    private pump: Promise<void> | undefined;

    constructor(options: TuiAgentPaneOptions<Client>) {
        this.client = options.client;
        this.onUpdate = options.onUpdate;
        this.onFailure = options.onFailure;
    }

    get agentId(): string {
        return this.client.agentId;
    }

    start(): void {
        this.pump ??= this.receiveUpdates();
    }

    async detach(): Promise<void> {
        this.controller.abort();
        await this.pump;
        await this.client.detach();
    }

    close(): void {
        this.controller.abort();
        this.client.close();
    }

    private async receiveUpdates(): Promise<void> {
        try {
            while (!this.controller.signal.aborted) {
                const update = await this.client.receive(this.controller.signal);
                if (this.controller.signal.aborted) {
                    return;
                }
                this.state.apply(update);
                this.onUpdate?.(update, this);
            }
        } catch (error) {
            if (this.controller.signal.aborted) {
                return;
            }
            const failure = error instanceof Error
                ? error
                : new Error(String(error));
            this.onFailure?.(failure, this);
        }
    }
}
