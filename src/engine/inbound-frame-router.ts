import { randomUUID } from "node:crypto";

import { AsyncQueue } from "./async-queue.ts";
import type {
    EngineEventBus,
    ToolApprovalUiResponse,
} from "./events.ts";
import type {
    AgentFrame,
    ClientFrame,
    PromptFrame,
    UiResponseFrame,
} from "./frames.ts";
import type { FrameEndpoint } from "./in-process-channel.ts";
import type { HookToolCall } from "../sdk/hooks.ts";

const FULL_USER_AUTHORITY_WARNING =
    "If allowed, this command and its child processes run with your full user permissions.";

export interface ToolApprovalOptions {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

export interface ToolApprovalAllowed {
    readonly behavior: "allow";
}

export interface ToolApprovalDenied {
    readonly behavior: "deny";
    readonly reason: string;
}

export type ToolApprovalResult = ToolApprovalAllowed | ToolApprovalDenied;

interface PendingApproval {
    readonly resolve: (result: ToolApprovalResult) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
}

export interface InboundTurn {
    readonly prompt: PromptFrame;
    readonly signal: AbortSignal;
}

export class InboundFrameRouter {
    private readonly prompts = new AsyncQueue<PromptFrame>();
    private readonly pendingApprovals = new Map<string, PendingApproval>();
    private waitingForPrompt = false;
    private activeTurn: AbortController | undefined;
    private receiveFailed = false;

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

    requestToolApproval(
        toolCall: HookToolCall,
        reason: string,
        options: ToolApprovalOptions,
    ): Promise<ToolApprovalResult> {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
            throw new Error("Approval timeout must be a positive finite number");
        }
        if (this.receiveFailed) {
            return Promise.resolve(noClientDenial());
        }
        if (options.signal?.aborted) {
            return Promise.resolve(abortedDenial());
        }

        const requestId = randomUUID();
        const result = new Promise<ToolApprovalResult>((resolve) => {
            const timer = setTimeout(() => {
                this.finishApproval(requestId, {
                    behavior: "deny",
                    reason: "Tool approval timed out.",
                });
            }, options.timeoutMs);
            const pending: PendingApproval = {
                resolve,
                timer,
                ...(options.signal === undefined
                    ? {}
                    : {
                        signal: options.signal,
                        onAbort: () => {
                            this.finishApproval(requestId, abortedDenial());
                        },
                    }),
            };
            this.pendingApprovals.set(requestId, pending);
            pending.signal?.addEventListener("abort", pending.onAbort!, {
                once: true,
            });
        });

        this.events.emit({
            type: "ui_request",
            requestId,
            request: {
                type: "tool_approval",
                toolCall,
                reason,
                warning: FULL_USER_AUTHORITY_WARNING,
            },
        });
        return result;
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

                if (frame.type === "ui_response") {
                    this.receiveUiResponse(frame);
                    continue;
                }

                if (frame.type === "abort" && this.activeTurn !== undefined) {
                    this.events.emit({ type: "abort_requested" });
                    this.activeTurn.abort(new Error("Turn aborted"));
                }
            }
        } catch (error) {
            this.receiveFailed = true;
            this.prompts.fail(error);
            for (const requestId of this.pendingApprovals.keys()) {
                this.finishApproval(requestId, noClientDenial());
            }
        }
    }

    private receiveUiResponse(frame: UiResponseFrame): void {
        if (!this.pendingApprovals.has(frame.requestId)) {
            return;
        }
        this.events.emit({
            type: "ui_response",
            requestId: frame.requestId,
            response: frame.response,
        });
        this.finishApproval(
            frame.requestId,
            approvalResult(frame.response),
        );
    }

    private finishApproval(
        requestId: string,
        result: ToolApprovalResult,
    ): void {
        const pending = this.pendingApprovals.get(requestId);
        if (pending === undefined) {
            return;
        }
        this.pendingApprovals.delete(requestId);
        clearTimeout(pending.timer);
        if (pending.signal !== undefined && pending.onAbort !== undefined) {
            pending.signal.removeEventListener("abort", pending.onAbort);
        }
        this.events.emit({ type: "ui_request_closed", requestId });
        pending.resolve(result);
    }
}

function approvalResult(
    response: ToolApprovalUiResponse,
): ToolApprovalResult {
    return response.decision === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", reason: "Tool use was denied by the user." };
}

function abortedDenial(): ToolApprovalDenied {
    return { behavior: "deny", reason: "Tool approval was cancelled." };
}

function noClientDenial(): ToolApprovalDenied {
    return {
        behavior: "deny",
        reason: "No client is available to approve this tool.",
    };
}
