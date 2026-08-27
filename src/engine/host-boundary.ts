/**
 * The single seam between the turn loop and its host.
 *
 * `run-turn.ts` reaches its owner only through this interface, so there is one
 * place to put a pipe under. `createLocalHostBoundary` is the in-process
 * implementation and the default: it calls `RunHeadlessLoopServices` directly
 * and adds no hop. A pipe implementation carrying `host-protocol.ts` messages
 * is the other implementation, and the two must be indistinguishable to the
 * loop.
 *
 * `readState` is one coarse read of everything the owner may change mid-turn.
 * The fields are lazy in-process, so each one costs exactly the call it costs
 * today; across a pipe the same object is the last `state.changed` push. Six
 * fine-grained reads therefore become one message without changing what an
 * in-process loop observes.
 *
 * `owned` holds the live objects that are not calls. Each one either does not
 * cross at all or crosses in a shape named in `host-protocol.ts`; none of them
 * may be reached from the loop except through this field, so a pipe
 * implementation knows exactly what it still has to supply.
 */

import type { AgentWearSnapshot } from "../agents/wear.ts";
import type { EffortPool } from "../model/effort-pool.ts";
import type { ModelFailureLedger } from "../store/model-failures.ts";
import type { SessionStore } from "../store/session-store.ts";
import type { ManagedProcessRegistry } from "../tools/process-runtime.ts";
import type {
    ApplyCommittedToolEffect,
    ApplyToolEffect,
    RegisteredTool,
} from "../tools/types.ts";
import type { EngineEventBus } from "./events.ts";
import type { ToolHooks } from "./hooks.ts";
import type { LoopState } from "./host-protocol.ts";
import type {
    InboundRouterHostHooks,
    LoopPolicy,
    RunHeadlessLoopServices,
} from "./loop-services.ts";
import type { InstructionRoot } from "./memory.ts";
import type { ModelTurnSettings } from "./model-settings.ts";
import type { ApprovalMode, PermissionPreference } from "./permissions.ts";
import type { PromptContribution } from "./prompt-contributions.ts";
import type { ReviewLog } from "./review-log.ts";
import type { ReviewToolCall, ToolReviewerSettings } from "./reviewer.ts";
import type { SessionCompactionOptions } from "./run-turn.ts";
import type { RequestMissingSubagentConfiguration } from "./subagent.ts";

/**
 * Which capabilities the owner offers.
 *
 * Absent is not the same as present and empty: an owner that offers no
 * `modelSettings` is not an owner reporting no settings, and the loop keeps a
 * different code path for each. Presence is a fact about the owner, so it is
 * answered here rather than inferred from a value.
 */
export interface HostBoundaryOffers {
    /** Paired with `updateApprovalMode`: an owner offers both or neither. */
    readonly approvalModeRead: boolean;
    readonly modelSettings: boolean;
    readonly agentWear: boolean;
}

/**
 * Live objects the loop holds rather than calls.
 *
 * `host-protocol.ts` names what each becomes on a wire. Three of them never
 * cross: the process registry, because a remote worker owns its own children;
 * the model-failure ledger, because it is a host-side subscriber of events the
 * worker already sends; and the router, because it stays host-side with the
 * client endpoint it owns.
 */
export interface HostOwnedObjects {
    /** Worker-side becomes a read-only replica fed by `session.record`. */
    readonly sessionStore?: SessionStore;
    /** Bidirectional: `event.emit` outward, `event.inject` inward. */
    readonly eventBus?: EngineEventBus;
    /** Becomes `pool.changed` pushed in, `pool.learned` reported back. */
    readonly effortPool?: EffortPool;
    /** Does not cross. */
    readonly modelFailureLedger?: ModelFailureLedger;
    /** Becomes the `reviewLog.append` notification. */
    readonly reviewLog?: ReviewLog;
    /** Becomes `hook.preToolUse`, `hook.postToolUse`, and `hook.preTurn`. */
    readonly hooks?: ToolHooks;
    /** Does not cross. */
    readonly processRegistry?: ManagedProcessRegistry;
    /** Definitions push in with `tools.changed`; calls are `tool.execute`. */
    readonly extensionTools?: readonly RegisteredTool[];
    /** The strategy is JSON; each bound model is `compaction.complete`. */
    readonly compaction?: SessionCompactionOptions;
    /** Does not cross. */
    readonly router: InboundRouterHostHooks;
}

export interface HostBoundary {
    readonly offers: HostBoundaryOffers;
    /** One coarse read of everything the owner may change mid-turn. */
    readState(): LoopState;
    /** `approval.update`. Absent when the owner does not own the mode. */
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    /**
     * `review.toolCall`. Absent means the loop reviews with its own adapter,
     * which stays worker-side rather than becoming a host call.
     */
    readonly reviewToolCall?: ReviewToolCall;
    /**
     * `effect.apply`. Absent means the loop applies effects itself, which is
     * what keeps subagents inside the worker: a subagent spawned by a host-side
     * applier would survive a kill of the worker that asked for it.
     */
    readonly applyToolEffect?: ApplyToolEffect;
    /**
     * `effect.apply`, for the effects the owner holds the state for.
     *
     * Present alongside an absent `applyToolEffect`: the loop keeps its own
     * applier for `spawn_subagent`, so a subagent stays a child of this
     * process, and hands every other effect to the owner. Ignored when
     * `applyToolEffect` is present, because that replaces the applier whole.
     */
    readonly applyHostToolEffect?: ApplyToolEffect;
    /** Owner-side semantic UI workflow for a missing subagent assignment. */
    readonly requestMissingSubagentConfiguration?:
        RequestMissingSubagentConfiguration;
    /** `effect.commit`. */
    readonly applyCommittedToolEffect?: ApplyCommittedToolEffect;
    /** `contributions.load`. */
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        allowedSkills?: readonly string[],
    ) => Promise<readonly PromptContribution[]>;
    readonly owned: HostOwnedObjects;
}

/**
 * The in-process boundary, and the default.
 *
 * Every member forwards to the services object with no copying and no
 * normalising, so an owner that passes `null` sees `null` and an owner that
 * omits a field sees it omitted.
 */
export function createLocalHostBoundary(
    services: RunHeadlessLoopServices,
): HostBoundary {
    const readPolicy = (): LoopPolicy => services.readPolicy?.() ?? {};
    const state: LoopState = {
        get policy(): LoopPolicy {
            return readPolicy();
        },
        get modelSettings(): ModelTurnSettings | undefined {
            return services.readModelSettings?.();
        },
        get agentWear(): AgentWearSnapshot | undefined {
            return services.readAgentWear?.();
        },
        get approvalMode(): ApprovalMode | undefined {
            return services.readApprovalMode?.();
        },
        get permissionPreferences(): readonly PermissionPreference[] {
            return services.readPermissionPreferences?.() ?? [];
        },
        get reviewer(): ToolReviewerSettings | undefined {
            return services.readReviewer?.() ?? readPolicy().reviewer;
        },
    };
    return {
        offers: {
            approvalModeRead: services.readApprovalMode !== undefined,
            modelSettings: services.readModelSettings !== undefined,
            agentWear: services.readAgentWear !== undefined,
        },
        readState: () => state,
        ...(services.updateApprovalMode === undefined
            ? {}
            : { updateApprovalMode: services.updateApprovalMode }),
        ...(services.reviewToolCall === undefined
            ? {}
            : { reviewToolCall: services.reviewToolCall }),
        ...(services.applyToolEffect === undefined
            ? {}
            : { applyToolEffect: services.applyToolEffect }),
        ...(services.requestMissingSubagentConfiguration === undefined
            ? {}
            : {
                requestMissingSubagentConfiguration:
                    services.requestMissingSubagentConfiguration,
            }),
        ...(services.applyCommittedToolEffect === undefined
            ? {}
            : { applyCommittedToolEffect: services.applyCommittedToolEffect }),
        ...(services.loadContextualContributions === undefined ? {} : {
            loadContextualContributions: services.loadContextualContributions,
        }),
        owned: {
            ...(services.sessionStore === undefined
                ? {}
                : { sessionStore: services.sessionStore }),
            ...(services.eventBus === undefined
                ? {}
                : { eventBus: services.eventBus }),
            ...(services.effortPool === undefined
                ? {}
                : { effortPool: services.effortPool }),
            ...(services.modelFailureLedger === undefined
                ? {}
                : { modelFailureLedger: services.modelFailureLedger }),
            ...(services.reviewLog === undefined
                ? {}
                : { reviewLog: services.reviewLog }),
            ...(services.hooks === undefined ? {} : { hooks: services.hooks }),
            ...(services.processRegistry === undefined
                ? {}
                : { processRegistry: services.processRegistry }),
            ...(services.extensionTools === undefined
                ? {}
                : { extensionTools: services.extensionTools }),
            ...(services.compaction === undefined
                ? {}
                : { compaction: services.compaction }),
            router: services.router ?? {},
        },
    };
}
