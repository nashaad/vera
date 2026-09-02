
import type { AgentSnapshot } from "../agents/snapshot.ts";
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
import { loopCompactionState, type LoopState } from "./host-protocol.ts";
import type {
    InboundRouterHostHooks,
    LoopPolicy,
    RunHeadlessLoopServices,
} from "./loop-services.ts";
import type { InstructionRoot } from "./memory.ts";
import type { ModelTurnSettings } from "./model-settings.ts";
import type { ApprovalMode, PermissionPreference } from "./permissions.ts";
import type {
    ContextualContributionContext,
    PromptContribution,
} from "./prompt-contributions.ts";
import type { ReviewLog } from "./review-log.ts";
import type { ReviewToolCall, ToolReviewerSettings } from "./reviewer.ts";
import type { SessionCompactionOptions } from "./run-turn.ts";
import type { RequestMissingSubagentConfiguration } from "./subagent.ts";

export interface HostBoundaryOffers {
    readonly approvalModeRead: boolean;
    readonly modelSettings: boolean;
    readonly selectedAgent: boolean;
}

export interface HostOwnedObjects {
    readonly sessionStore?: SessionStore;
    readonly eventBus?: EngineEventBus;
    readonly effortPool?: EffortPool;
    readonly modelFailureLedger?: ModelFailureLedger;
    readonly reviewLog?: ReviewLog;
    readonly hooks?: ToolHooks;
    readonly processRegistry?: ManagedProcessRegistry;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly compaction?: SessionCompactionOptions;
    readonly router: InboundRouterHostHooks;
}

export interface HostBoundary {
    readonly offers: HostBoundaryOffers;
    readState(): LoopState;
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    readonly reviewToolCall?: ReviewToolCall;
    readonly applyToolEffect?: ApplyToolEffect;
    readonly applyHostToolEffect?: ApplyToolEffect;
    readonly requestMissingSubagentConfiguration?:
        RequestMissingSubagentConfiguration;
    readonly applyCommittedToolEffect?: ApplyCommittedToolEffect;
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        allowedSkills?: readonly string[],
        context?: ContextualContributionContext,
    ) => Promise<readonly PromptContribution[]>;
    readonly owned: HostOwnedObjects;
}

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
        get selectedAgent(): AgentSnapshot | undefined {
            return services.readSelectedAgent?.();
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
        get compaction() {
            return loopCompactionState(services.compaction?.diagnostics);
        },
    };
    return {
        offers: {
            approvalModeRead: services.readApprovalMode !== undefined,
            modelSettings: services.readModelSettings !== undefined,
            selectedAgent: services.readSelectedAgent !== undefined,
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
            get compaction() {
                return services.compaction;
            },
            router: services.router ?? {},
        },
    };
}
