/**
 * The host's side of the worker pipe.
 *
 * Answers what the worker asks against the real services, and pushes what the
 * worker cannot ask for synchronously. The session file is written here and
 * nowhere else: an append arrives as a request, the host writes it, and the
 * reply names the line it landed on.
 *
 * Everything this file touches survives the worker dying. That is the point of
 * which side it is on.
 */

import type { EngineEvent } from "../../engine/events.ts";
import type { LoopState } from "../../engine/host-protocol.ts";
import type { RunHeadlessLoopServices } from "../../engine/loop-services.ts";
import type { AgentUpdate } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import type { ReviewLogEntry } from "../../engine/review-log.ts";
import type { SessionStore } from "../../store/session-store.ts";
import type { RegisteredTool } from "../../tools/types.ts";
import type { ToolRuntime } from "../../tools/runtime.ts";
import type { JsonPipe } from "./pipe.ts";

export interface WorkerBoundaryServerOptions {
    readonly pipe: JsonPipe;
    /** The real store. This process is its only writer. */
    readonly store: SessionStore;
    readonly services: RunHeadlessLoopServices;
    /** Extension tools by name, resolved host-side. */
    readonly extensionTools?: readonly RegisteredTool[];
    readonly toolRuntime?: ToolRuntime;
    /** Client updates the worker produced. */
    readonly onClientUpdate?: (update: AgentUpdate, ownerId?: string) => void;
    readonly onWorkerFinished?: (error?: string) => void;
    readonly onProcessStarted?: (pid: number) => void;
    readonly onProcessSettled?: (pid: number) => void;
}

export interface WorkerBoundaryServer {
    /** Feeds one frame body the worker sent. Requests get a reply. */
    handleRequest(body: unknown): Promise<unknown>;
    handleNotification(body: unknown): void;
    /** A record the host wrote on its own initiative. */
    pushRecord(lineNumber: number, record: Record<string, unknown>): void;
    pushState(state: LoopState): void;
    injectEvent(event: EngineEvent): void;
    sendCommand(command: EngineCommand): void;
    /** The line the last host-performed append landed on. */
    readonly lastLineNumber: number;
}

export function createWorkerBoundaryServer(
    options: WorkerBoundaryServerOptions,
): WorkerBoundaryServer {
    const { pipe, services } = options;
    const cancellers = new Map<string, AbortController>();
    const toolsByName = new Map(
        (options.extensionTools ?? []).map((tool) => [tool.definition.name, tool]),
    );
    // The store's own writes and the worker's share one sequence, and the host
    // is the only writer, so this counter is the file's line count.
    let lineNumber = options.store.appendedLineCount?.() ?? 0;
    // One bus, two processes. An event arriving from the worker is emitted
    // here for the host's own subscribers, and must not be sent straight back
    // to the worker that produced it.
    let ingesting = false;
    services.eventBus?.subscribe((event: EngineEvent) => {
        if (ingesting) {
            return;
        }
        pipe.notify({ method: "event.inject", event });
    });

    const server: WorkerBoundaryServer = {
        async handleRequest(body: unknown): Promise<unknown> {
            const message = body as { readonly method: string };
            switch (message.method) {
                case "session.append": {
                    const request = body as {
                        readonly record: Record<string, unknown>;
                    };
                    const line = await options.store.appendForeignRecord(
                        request.record,
                    );
                    lineNumber = line;
                    return { lineNumber: line };
                }
                case "agent.wear": {
                    const request = body as { readonly name: string };
                    const worn = await services.router?.wearAgent?.(
                        request.name,
                    );
                    return worn === undefined ? {} : { worn };
                }
                case "skills.list": {
                    if (services.router?.listSkills === undefined) {
                        throw new Error("The host offers no skill catalog");
                    }
                    return {
                        catalog: await services.router.listSkills(),
                    };
                }
                case "skills.invoke": {
                    if (services.router?.invokeSkill === undefined) {
                        throw new Error("The host offers no skill invocation");
                    }
                    const request = body as { readonly name: string };
                    return {
                        decision: await services.router.invokeSkill(
                            request.name,
                        ),
                    };
                }
                case "approval.update": {
                    const request = body as { readonly mode: never };
                    const mode = await services.updateApprovalMode?.(
                        request.mode,
                    );
                    return mode === undefined ? {} : { mode };
                }
                case "review.toolCall": {
                    const request = body as {
                        readonly callId: string;
                        readonly request: never;
                    };
                    const controller = new AbortController();
                    cancellers.set(request.callId, controller);
                    try {
                        const decision = await services.reviewToolCall?.(
                            request.request,
                            controller.signal,
                        );
                        return { decision };
                    } finally {
                        cancellers.delete(request.callId);
                    }
                }
                case "effect.apply": {
                    const request = body as {
                        readonly callId: string;
                        readonly effect: never;
                        readonly context: never;
                    };
                    if (services.applyToolEffect === undefined) {
                        throw new Error(
                            "The host applies no tool effects",
                        );
                    }
                    const controller = new AbortController();
                    cancellers.set(request.callId, controller);
                    try {
                        return {
                            output: await services.applyToolEffect(
                                request.effect,
                                controller.signal,
                                request.context,
                            ),
                        };
                    } finally {
                        cancellers.delete(request.callId);
                    }
                }
                case "subagent.configure": {
                    const request = body as {
                        readonly callId: string;
                        readonly request: never;
                        readonly context: never;
                    };
                    if (
                        services.requestMissingSubagentConfiguration
                            === undefined
                    ) {
                        throw new Error(
                            "The host offers no subagent configuration workflow",
                        );
                    }
                    const controller = new AbortController();
                    cancellers.set(request.callId, controller);
                    try {
                        return {
                            resolution: await services
                                .requestMissingSubagentConfiguration(
                                    request.request,
                                    request.context,
                                    controller.signal,
                                ),
                        };
                    } finally {
                        cancellers.delete(request.callId);
                    }
                }
                case "effect.commit": {
                    const request = body as { readonly effect: never };
                    await services.applyCommittedToolEffect?.(request.effect);
                    return { result: null };
                }
                case "contributions.load": {
                    const request = body as {
                        readonly instructionRoot: never;
                        readonly allowedSkills?: readonly string[];
                    };
                    const contributions = await services
                        .loadContextualContributions?.(
                            request.instructionRoot,
                            request.allowedSkills,
                        ) ?? [];
                    return { contributions };
                }
                case "tool.execute": {
                    const request = body as {
                        readonly callId: string;
                        readonly name: string;
                        readonly input: Readonly<Record<string, unknown>>;
                    };
                    const tool = toolsByName.get(request.name);
                    if (tool === undefined || options.toolRuntime === undefined) {
                        throw new Error(
                            `No extension tool named ${request.name}`,
                        );
                    }
                    const controller = new AbortController();
                    cancellers.set(request.callId, controller);
                    try {
                        const result = await tool.execute(
                            request.input,
                            options.toolRuntime,
                            controller.signal,
                        );
                        return { result };
                    } finally {
                        cancellers.delete(request.callId);
                    }
                }
                case "hook.preToolUse": {
                    const request = body as {
                        readonly payload: never;
                        readonly options: never;
                    };
                    const outcome = await services.hooks?.runPreToolUse(
                        request.payload,
                        request.options,
                    ) ?? { power: "observe" };
                    return { outcome };
                }
                case "hook.postToolUse": {
                    const request = body as {
                        readonly payload: never;
                        readonly options: never;
                    };
                    const result = await services.hooks?.runPostToolUse(
                        request.payload,
                        request.options,
                    );
                    return { result };
                }
                default:
                    throw new Error(
                        `The host does not answer ${message.method}`,
                    );
            }
        },
        handleNotification(body: unknown): void {
            const message = body as { readonly method: string };
            if (message.method === "call.cancel") {
                const { callId } = body as { readonly callId: string };
                cancellers.get(callId)?.abort();
                return;
            }
            if (message.method === "event.emit") {
                const { event } = body as { readonly event: EngineEvent };
                ingesting = true;
                try {
                    services.eventBus?.emit(event);
                } finally {
                    ingesting = false;
                }
                return;
            }
            if (message.method === "reviewLog.append") {
                const { entry } = body as { readonly entry: ReviewLogEntry };
                services.reviewLog?.(entry);
                return;
            }
            if (message.method === "client.update") {
                const { update, ownerId } = body as {
                    readonly update: AgentUpdate;
                    readonly ownerId?: string;
                };
                options.onClientUpdate?.(update, ownerId);
                return;
            }
            if (message.method === "worker.finished") {
                const { error } = body as { readonly error?: string };
                options.onWorkerFinished?.(error);
                return;
            }
            if (message.method === "process.started") {
                const { pid } = body as { readonly pid: number };
                options.onProcessStarted?.(pid);
                return;
            }
            if (message.method === "process.settled") {
                const { pid } = body as { readonly pid: number };
                options.onProcessSettled?.(pid);
                return;
            }
        },
        pushRecord(line: number, record: Record<string, unknown>): void {
            lineNumber = line;
            pipe.notify({
                method: "session.record",
                lineNumber: line,
                record,
            });
        },
        pushState(state: LoopState): void {
            pipe.notify({ method: "state.changed", state });
        },
        injectEvent(event: EngineEvent): void {
            pipe.notify({ method: "event.inject", event });
        },
        sendCommand(command: EngineCommand): void {
            pipe.notify({ method: "client.command", command });
        },
        get lastLineNumber(): number {
            return lineNumber;
        },
    };
    return server;
}
