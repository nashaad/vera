import type {
    AgentUpdate,
    ClientCommand,
} from "../../src/engine/protocol.ts";
import type { TuiAgentAttachment } from "./agent-attachments.ts";
import { TuiAgentPaneState } from "./agent-pane-state.ts";

export interface TuiAgentPaneClient {
    readonly agentId: string;
    send(command: ClientCommand): Promise<void>;
    receive(signal?: AbortSignal): Promise<AgentUpdate>;
    detach(): Promise<void>;
    close(): void;
}

export interface TuiAgentPaneImageAttachment {
    readonly id: string;
    readonly name?: string;
}

interface PendingImageAttachment {
    readonly resolve: (attachment: TuiAgentPaneImageAttachment) => void;
    readonly reject: (error: Error) => void;
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
    private readonly pendingImages = new Map<string, PendingImageAttachment>();
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

    async attachImage(
        requestId: string,
        path: string,
        signal: AbortSignal,
    ): Promise<TuiAgentPaneImageAttachment> {
        signal.throwIfAborted();
        if (this.controller.signal.aborted) {
            throw new Error("Agent attachment is closed");
        }
        const completion = Promise.withResolvers<TuiAgentPaneImageAttachment>();
        const abort = (): void => {
            this.pendingImages.delete(requestId);
            completion.reject(new Error("Image attachment was cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        this.pendingImages.set(requestId, completion);
        try {
            await this.client.send({ type: "attach_image", requestId, path });
            return await completion.promise;
        } catch (error) {
            this.pendingImages.delete(requestId);
            throw error;
        } finally {
            signal.removeEventListener("abort", abort);
        }
    }

    async detach(): Promise<void> {
        this.controller.abort();
        this.rejectPendingImages("Agent detached while attaching an image");
        await this.pump;
        await this.client.detach();
    }

    close(): void {
        this.controller.abort();
        this.rejectPendingImages("Agent closed while attaching an image");
        this.client.close();
    }

    private async receiveUpdates(): Promise<void> {
        try {
            while (!this.controller.signal.aborted) {
                const update = await this.client.receive(this.controller.signal);
                if (this.controller.signal.aborted) {
                    return;
                }
                if (update.type === "image_attached") {
                    const pending = this.pendingImages.get(update.requestId);
                    this.pendingImages.delete(update.requestId);
                    pending?.resolve(update.attachment);
                } else if (update.type === "image_attachment_rejected") {
                    const pending = this.pendingImages.get(update.requestId);
                    this.pendingImages.delete(update.requestId);
                    pending?.reject(new Error(update.error));
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
            this.rejectPendingImages(failure.message);
            this.onFailure?.(failure, this);
        }
    }

    private rejectPendingImages(message: string): void {
        for (const pending of this.pendingImages.values()) {
            pending.reject(new Error(message));
        }
        this.pendingImages.clear();
    }
}
