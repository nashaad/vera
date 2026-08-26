/**
 * The worker's `HostBoundary`, carried over a pipe.
 *
 * Behaviourally indistinguishable from `createLocalHostBoundary` as far as the
 * loop is concerned: the loop calls the same members and observes the same
 * presence and absence. What changes is where the work happens.
 *
 * Two members are deliberately absent rather than remote:
 *
 * - `applyToolEffect`, so the loop builds its own applier. That is what keeps a
 *   subagent a child of this worker's process. A host-side applier would run
 *   model loops in the host and would leave a subagent alive after this process
 *   is killed, which is the case the split exists for. `applyHostToolEffect`
 *   carries only the effects whose state the host holds.
 * - Tool processes remain worker-owned. Their group lifetimes are reported to
 *   the supervisor so an external worker kill cannot orphan them.
 *
 * The session store holds no file descriptor. Reads answer from a projection
 * folded out of the record stream; writes go out as `session.append` and the
 * host performs them. See `session.ts`.
 */

import { EngineEventBus, type EngineEvent } from "../../engine/events.ts";
import { ToolHooks } from "../../engine/hooks.ts";
import type {
    HostBoundary,
    HostBoundaryOffers,
} from "../../engine/host-boundary.ts";
import type { LoopState } from "../../engine/host-protocol.ts";
import type { InstructionRoot } from "../../engine/memory.ts";
import type { ApprovalMode } from "../../engine/permissions.ts";
import type { PromptContribution } from "../../engine/prompt-contributions.ts";
import type { ReviewLog, ReviewLogEntry } from "../../engine/review-log.ts";
import type { ToolReviewDecision } from "../../engine/reviewer.ts";
import { ManagedProcessRegistry } from "../../tools/process-runtime.ts";
import type { ToolRuntime } from "../../tools/runtime.ts";
import type {
    AppliedToolEffectOutput,
    CommitEffect,
    RegisteredTool,
    RegisteredToolDefinition,
    ToolExecutionResult,
} from "../../tools/types.ts";
import type {
    SkillCommandCatalog,
    SkillInvocationDecision,
} from "../../skills/commands.ts";
import type { JsonPipe } from "./pipe.ts";
import { WorkerSessionStore } from "./session.ts";
import type {
    WorkerHostCapabilities,
    WorkerSessionSeed,
} from "./start.ts";

export interface RemoteHostBoundaryOptions {
    readonly pipe: JsonPipe;
    readonly session: WorkerSessionSeed;
    readonly offers: HostBoundaryOffers;
    readonly capabilities: WorkerHostCapabilities;
    readonly state: LoopState;
    /** Present when this process loaded the extensions itself. */
    readonly localExtensionTools?: readonly RegisteredTool[];
    readonly extensionToolDefinitions?: readonly RegisteredToolDefinition[];
}

export interface RemoteHostBoundary {
    readonly boundary: HostBoundary;
    /** Handles one host-to-worker notification. Unknown methods are ignored. */
    acceptNotification(body: unknown): void;
}

export function createRemoteHostBoundary(
    options: RemoteHostBoundaryOptions,
): RemoteHostBoundary {
    const { pipe, capabilities } = options;
    let state = options.state;

    const store = WorkerSessionStore.seed(
        options.session.path,
        options.session.header,
    );
    for (const [index, record] of options.session.records.entries()) {
        store.applyHostRecord(index + 2, record);
    }
    store.setAppender(async (record) => {
        const reply = await pipe.request({
            method: "session.append",
            record,
        }) as { readonly lineNumber: number };
        return reply.lineNumber;
    });

    const eventBus = new EngineEventBus();
    let injecting = false;
    eventBus.subscribe((event: EngineEvent) => {
        if (injecting) {
            return;
        }
        pipe.notify({ method: "event.emit", event });
    });

    const hooks = capabilities.hooks
        ? remoteHooks(pipe)
        : new ToolHooks();
    const processRegistry = new ManagedProcessRegistry({
        onProcessStarted: (pid) =>
            pipe.notify({ method: "process.started", pid }),
        onProcessSettled: (pid) =>
            pipe.notify({ method: "process.settled", pid }),
    });

    const reviewLog: ReviewLog | undefined = capabilities.reviewLog
        ? (entry: ReviewLogEntry): void => {
            pipe.notify({ method: "reviewLog.append", entry });
        }
        : undefined;

    // Tools the worker loaded itself replace the proxies whole: a tool that
    // runs here must not also be reachable by name over the boundary.
    const extensionTools = options.localExtensionTools
        ?? (options.extensionToolDefinitions ?? []).map(
        (registered): RegisteredTool => ({
            definition: registered.definition,
            ...(registered.invocation === undefined
                ? {}
                : { invocation: registered.invocation }),
            async execute(
                input: Readonly<Record<string, unknown>>,
                _context: ToolRuntime,
                signal: AbortSignal,
            ): Promise<ToolExecutionResult> {
                const callId = newCallId();
                const abort = (): void =>
                    pipe.notify({ method: "call.cancel", callId });
                signal.addEventListener("abort", abort, { once: true });
                try {
                    const reply = await pipe.request({
                        method: "tool.execute",
                        callId,
                        name: registered.definition.name,
                        input,
                    }) as { readonly result: ToolExecutionResult };
                    return reply.result;
                } finally {
                    signal.removeEventListener("abort", abort);
                }
            },
        }),
        );

    const boundary: HostBoundary = {
        offers: options.offers,
        readState: () => state,
        ...(capabilities.updateApprovalMode
            ? {
                updateApprovalMode: async (
                    mode: ApprovalMode,
                ): Promise<ApprovalMode | undefined> => {
                    const reply = await pipe.request({
                        method: "approval.update",
                        mode,
                    }) as { readonly mode?: ApprovalMode };
                    return reply.mode;
                },
            }
            : {}),
        ...(capabilities.reviewToolCall
            ? {
                reviewToolCall: async (
                    request,
                    signal,
                ): Promise<ToolReviewDecision> => {
                    const callId = newCallId();
                    const abort = (): void =>
                        pipe.notify({ method: "call.cancel", callId });
                    signal?.addEventListener("abort", abort, { once: true });
                    try {
                        const reply = await pipe.request({
                            method: "review.toolCall",
                            callId,
                            request,
                        }) as { readonly decision: ToolReviewDecision };
                        return reply.decision;
                    } finally {
                        signal?.removeEventListener("abort", abort);
                    }
                },
            }
            : {}),
        ...(capabilities.applyHostToolEffect
            ? {
                applyHostToolEffect: async (
                    effect,
                    signal,
                    context,
                ): Promise<AppliedToolEffectOutput> => {
                    const callId = newCallId();
                    const abort = (): void =>
                        pipe.notify({ method: "call.cancel", callId });
                    signal.addEventListener("abort", abort, { once: true });
                    try {
                        const reply = await pipe.request({
                            method: "effect.apply",
                            callId,
                            effect,
                            context,
                        }) as {
                            readonly output: AppliedToolEffectOutput;
                        };
                        return reply.output;
                    } finally {
                        signal.removeEventListener("abort", abort);
                    }
                },
            }
            : {}),
        ...(capabilities.requestMissingSubagentConfiguration
            ? {
                requestMissingSubagentConfiguration: async (
                    request,
                    context,
                    signal,
                ) => {
                    const callId = newCallId();
                    const abort = (): void =>
                        pipe.notify({ method: "call.cancel", callId });
                    signal.addEventListener("abort", abort, { once: true });
                    try {
                        const reply = await pipe.request({
                            method: "subagent.configure",
                            callId,
                            request,
                            context,
                        }) as { readonly resolution: never };
                        return reply.resolution;
                    } finally {
                        signal.removeEventListener("abort", abort);
                    }
                },
            }
            : {}),
        ...(capabilities.applyCommittedToolEffect
            ? {
                applyCommittedToolEffect: async (
                    effect: CommitEffect,
                ): Promise<void> => {
                    await pipe.request({ method: "effect.commit", effect });
                },
            }
            : {}),
        ...(capabilities.loadContextualContributions
            ? {
                loadContextualContributions: async (
                    instructionRoot: InstructionRoot,
                    allowedSkills?: readonly string[],
                ): Promise<readonly PromptContribution[]> => {
                    const reply = await pipe.request({
                        method: "contributions.load",
                        instructionRoot,
                        ...(allowedSkills === undefined
                            ? {}
                            : { allowedSkills }),
                    }) as {
                        readonly contributions: readonly PromptContribution[];
                    };
                    return reply.contributions;
                },
            }
            : {}),
        owned: {
            sessionStore: store,
            eventBus,
            hooks,
            processRegistry,
            ...(reviewLog === undefined ? {} : { reviewLog }),
            ...(extensionTools.length === 0 ? {} : { extensionTools }),
            router: {
                ...(capabilities.wearAgent
                    ? {
                        wearAgent: async (name: string) => {
                            const reply = await pipe.request({
                                method: "agent.wear",
                                name,
                            }) as {
                                readonly worn?: {
                                    readonly name: string;
                                    readonly tools?: readonly string[];
                                    readonly skills?: readonly string[];
                                    readonly posture?: string;
                                    readonly notice?: string;
                                };
                            };
                            return reply.worn;
                        },
                    }
                    : {}),
                ...(capabilities.listSkills
                    ? {
                        listSkills: async (): Promise<SkillCommandCatalog> => {
                            const reply = await pipe.request({
                                method: "skills.list",
                            }) as { readonly catalog: SkillCommandCatalog };
                            return reply.catalog;
                        },
                    }
                    : {}),
                ...(capabilities.invokeSkill
                    ? {
                        invokeSkill: async (
                            name: string,
                        ): Promise<SkillInvocationDecision> => {
                            const reply = await pipe.request({
                                method: "skills.invoke",
                                name,
                            }) as {
                                readonly decision: SkillInvocationDecision;
                            };
                            return reply.decision;
                        },
                    }
                    : {}),
                ...(capabilities.hasPendingDeliveryTurn
                    ? { hasPendingDeliveryTurn: (): boolean => false }
                    : {}),
                sendTimelineReply: (ownerId, update): void => {
                    pipe.notify({
                        method: "client.update",
                        ownerId,
                        update,
                    });
                },
                sendSessionNameReply: (ownerId, update): void => {
                    pipe.notify({
                        method: "client.update",
                        ownerId,
                        update,
                    });
                },
                sendConsultReply: (ownerId, update): void => {
                    pipe.notify({
                        method: "client.update",
                        ownerId,
                        update,
                    });
                },
            },
        },
    };

    return {
        boundary,
        acceptNotification(body: unknown): void {
            const message = body as { readonly method?: string };
            if (message.method === "session.record") {
                const record = body as {
                    readonly lineNumber: number;
                    readonly record: Record<string, unknown>;
                };
                store.applyHostRecord(record.lineNumber, record.record);
                return;
            }
            if (message.method === "state.changed") {
                state = (body as { readonly state: LoopState }).state;
                return;
            }
            if (message.method === "event.inject") {
                injecting = true;
                try {
                    eventBus.emit((body as { readonly event: EngineEvent })
                        .event);
                } finally {
                    injecting = false;
                }
                return;
            }
        },
    };
}

/**
 * Hooks are registered on the owner's side, so both calls are relayed whole,
 * options included: the owner runs them and its answer is the outcome.
 */
function remoteHooks(pipe: JsonPipe): ToolHooks {
    const hooks = new ToolHooks();
    hooks.runPreToolUse = async (payload, options) => {
        const reply = await pipe.request({
            method: "hook.preToolUse",
            payload,
            options,
        }) as { readonly outcome: never };
        return reply.outcome;
    };
    hooks.runPostToolUse = async (payload, options) => {
        const reply = await pipe.request({
            method: "hook.postToolUse",
            payload,
            options,
        }) as { readonly result: never };
        return reply.result;
    };
    return hooks;
}

let callCounter = 0;

function newCallId(): string {
    callCounter += 1;
    return `w${callCounter}`;
}
