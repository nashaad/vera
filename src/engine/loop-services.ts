
import type { AgentSnapshot } from "../agents/snapshot.ts";
import type { AgentDefinition } from "../agents/definition.ts";
import type { EffortPool } from "../model/effort-pool.ts";
import type { ModelFailureLedger } from "../store/model-failures.ts";
import type {
    SessionSettingOrigin,
    SessionStore,
} from "../store/session-store.ts";
import type {
    ApplyCommittedToolEffect,
    ApplyToolEffect,
    RegisteredTool,
    ToolEffect,
} from "../tools/types.ts";
import type { ManagedProcessRegistry } from "../tools/process-runtime.ts";
import type { EngineEventBus, PoolAdmissionVerdict } from "./events.ts";
import type { ToolHooks } from "./hooks.ts";
import type { ToolResultLimits } from "./tool-result-history.ts";
import type {
    InboundCommandRouter,
    InboundCommandRouterOptions,
    SessionModelSettingsResult,
} from "./inbound-command-router.ts";
import type { InstructionRoot } from "./memory.ts";
import type { ModelSettingsPatch, ModelTurnSettings } from "./model-settings.ts";
import type {
    ApprovalMode,
    PermissionMode,
    PermissionPredicate,
    PermissionPreference,
} from "./permissions.ts";
import type {
    ContextualContributionContext,
    PromptContribution,
} from "./prompt-contributions.ts";
import type { ModelFallbackPolicy } from "./recovery.ts";
import type { ReviewLog } from "./review-log.ts";
import type { ReviewToolCall, ToolReviewerSettings } from "./reviewer.ts";
import type { SessionNameReplyUpdate, TimelineReplyUpdate } from "./protocol.ts";
import type { SessionCompactionOptions } from "./run-turn.ts";
import type {
    RequestMissingSubagentConfiguration,
    SubagentPoolPolicy,
} from "./subagent.ts";

export interface LoopPolicy {
    readonly modelFallback?: ModelFallbackPolicy;
    readonly permissionModes?: Readonly<Record<string, PermissionMode>>;
    readonly reviewer?: ToolReviewerSettings;
    readonly reviewers?: Readonly<Record<string, ToolReviewerSettings>>;
    readonly disabledPromptContributions?: readonly string[];
    readonly subagentPolicy?: SubagentPoolPolicy;
}

export interface RunHeadlessLoopData {
    readonly sessionId?: string;
    readonly sessionPath?: string;
    readonly resumeSessionPath?: string;
    readonly sessionStartReason?: "start" | "resume";
    readonly eventLogPath?: string;
    readonly approvalMode?: ApprovalMode;
    readonly enabledToolEffects?: readonly ToolEffect["type"][];
    readonly enableUserInteraction?: boolean;
    readonly offerTools?: boolean;
    readonly loadOptionalContext?: boolean;
    readonly toolEnv?: Readonly<Record<string, string>>;
    readonly instructionRoot?: InstructionRoot;
}

export interface InboundRouterHostHooks {
    readonly onInboundReady?: (inbound: InboundCommandRouter) => void;
    readonly hasPendingDeliveryTurn?: () => boolean;
    readonly onDeliveryTurnDiscarded?: () => void;
    readonly updateModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly updateSessionModelSettings?: (
        patch: ModelSettingsPatch,
    ) => Promise<SessionModelSettingsResult | undefined>;
    readonly readSessionModelSettingsHistory?: () => readonly {
        readonly settings: ModelTurnSettings;
        readonly origin: SessionSettingOrigin;
        readonly timestamp: string;
    }[];
    readonly updateSessionPermissionMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    readonly selectAgent?: InboundCommandRouterOptions["selectAgent"];
    readonly listCustomizationSources?: InboundCommandRouterOptions["listCustomizationSources"];
    readonly listAgents?: InboundCommandRouterOptions["listAgents"];
    readonly listSkills?: InboundCommandRouterOptions["listSkills"];
    readonly invokeSkill?: InboundCommandRouterOptions["invokeSkill"];
    readonly updateAgentDefaultPair?:
        InboundCommandRouterOptions["updateAgentDefaultPair"];
    readonly readApprovalModeOrigin?: () => SessionSettingOrigin | undefined;
    readonly poolAdd?: (
        entry: { readonly provider: string; readonly model: string },
        onStep: (step: {
            readonly step: string;
            readonly label: string;
            readonly status: "running" | "passed" | "failed" | "skipped";
            readonly detail?: string;
        }) => void,
        options?: { readonly verify?: boolean },
    ) => Promise<{
        readonly verdict: PoolAdmissionVerdict;
        readonly reason?: string;
        readonly statusCode?: number;
        readonly settings?: ModelTurnSettings;
    }>;
    readonly poolRemove?: (
        entry: { readonly provider: string; readonly model: string },
    ) => Promise<ModelTurnSettings | undefined>;
    readonly refreshCatalog?: (
        provider: string,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly poolName?: (
        entry: { readonly provider: string; readonly model: string },
        name: string | null,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly poolMove?: (
        entry: { readonly provider: string; readonly model: string },
        delta: number,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly addPermissionPreference?: (
        when: PermissionPredicate,
    ) => Promise<PermissionPreference | undefined>;
    readonly removePermissionPreference?: (id: string) => Promise<boolean>;
    readonly updateSessionName?: (
        name: string | null,
    ) => Promise<string | null | undefined>;
    readonly sendTimelineReply?: (
        ownerId: string,
        reply: TimelineReplyUpdate,
    ) => void;
    readonly sendSessionNameReply?: (
        ownerId: string,
        reply: SessionNameReplyUpdate,
    ) => void;
    readonly oneshot?: InboundCommandRouterOptions["oneshot"];
    readonly sendOneshotReply?: InboundCommandRouterOptions["sendOneshotReply"];
}

export interface RunHeadlessLoopServices {

    readonly sessionStore?: SessionStore;
    readonly eventBus?: EngineEventBus;
    readonly effortPool?: EffortPool;
    readonly modelFailureLedger?: ModelFailureLedger;
    readonly reviewLog?: ReviewLog;
    readonly hooks?: ToolHooks;
    readonly processRegistry?: ManagedProcessRegistry;
    readonly extensionTools?: readonly RegisteredTool[];
    readonly compaction?: SessionCompactionOptions;
    readonly toolResults?: ToolResultLimits;

    readonly readPolicy?: () => LoopPolicy;
    readonly readModelSettings?: () => ModelTurnSettings;
    readonly readSelectedAgent?: () => AgentSnapshot | undefined;
    readonly loadAgents?: () => Promise<readonly AgentDefinition[]>;
    readonly readApprovalMode?: () => ApprovalMode;
    readonly updateApprovalMode?: (
        mode: ApprovalMode,
    ) => Promise<ApprovalMode | undefined>;
    readonly readPermissionPreferences?: () => readonly PermissionPreference[];
    readonly readReviewer?: () => ToolReviewerSettings | undefined;
    readonly reviewToolCall?: ReviewToolCall;
    readonly applyToolEffect?: ApplyToolEffect;
    readonly requestMissingSubagentConfiguration?:
        RequestMissingSubagentConfiguration;
    readonly applyCommittedToolEffect?: ApplyCommittedToolEffect;
    readonly loadContextualContributions?: (
        instructionRoot: InstructionRoot,
        allowedSkills?: readonly string[],
        context?: ContextualContributionContext,
    ) => Promise<readonly PromptContribution[]>;

    readonly router?: InboundRouterHostHooks;
}
