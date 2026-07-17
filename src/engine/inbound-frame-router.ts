import { AsyncQueue } from "./async-queue.ts";
import type { EngineEventBus } from "./events.ts";
import type { AgentFrame, ClientFrame, PromptFrame } from "./frames.ts";
import type { FrameEndpoint } from "./in-process-channel.ts";

export interface InboundTurn {
    readonly prompt: PromptFrame;
    readonly signal: AbortSignal;
}

export class InboundFrameRouter {
    private readonly prompts = new AsyncQueue<PromptFrame>();
    private waitingForPrompt = false;
    private activeTurn: AbortController | undefined;

    constructor(
        endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
        private readonly events: EngineEventBus,
    ) {
        void this.receiveFrames(endpoint);
    }

    async startTurn(): Promise<InboundTurn> {
        if (this.waitingForPrompt || this.activeTurn !== undefined) {
            throw new Error("A turn is already pending or active");
        }

        this.waitingForPrompt = true;
        let prompt: PromptFrame;
        try {
            prompt = await this.prompts.receive();
        } finally {
            this.waitingForPrompt = false;
        }
        const controller = new AbortController();
        this.activeTurn = controller;
        return { prompt, signal: controller.signal };
    }

    finishTurn(): void {
        if (this.activeTurn === undefined) {
            throw new Error("No turn is active");
        }
        this.activeTurn = undefined;
    }

    private async receiveFrames(
        endpoint: FrameEndpoint<AgentFrame, ClientFrame>,
    ): Promise<void> {
        try {
            while (true) {
                const frame = await endpoint.receive();
                if (frame.type === "prompt") {
                    this.prompts.push(frame);
                    if (this.activeTurn !== undefined) {
                        this.events.emit({
                            type: "prompt_queued",
                            content: frame.content,
                        });
                    }
                    continue;
                }

                if (this.activeTurn !== undefined) {
                    this.events.emit({ type: "abort_requested" });
                    this.activeTurn.abort(new Error("Turn aborted"));
                }
            }
        } catch (error) {
            this.prompts.fail(error);
        }
    }
}
