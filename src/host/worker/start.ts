
import type { RegisteredToolDefinition } from "../../tools/types.ts";
import type { ModelReasoningEffort } from "../../model/types.ts";
import type { AgentUpdate } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import type { HostBoundaryOffers } from "../../engine/host-boundary.ts";
import type { LoopState } from "../../engine/host-protocol.ts";
import type { CompactionWireSpec } from "../../engine/compaction-binding.ts";
import type { ToolResultLimits } from "../../engine/tool-result-history.ts";
import type { RunHeadlessLoopData } from "../../engine/loop-services.ts";

export interface WorkerAdapterSpec {
    readonly module: string;
    readonly export?: string;
    readonly options?: unknown;
}

export interface WorkerSessionSeed {
    readonly path: string;
    readonly header: Record<string, unknown>;
    readonly records: readonly Record<string, unknown>[];
}

import type { VeraExtensionConfig } from "../../config.ts";

export interface WorkerHostCapabilities {
    readonly updateApprovalMode: boolean;
    readonly reviewToolCall: boolean;
    readonly applyHostToolEffect: boolean;
    readonly requestMissingSubagentConfiguration: boolean;
    readonly applyCommittedToolEffect: boolean;
    readonly loadContextualContributions: boolean;
    readonly hooks: boolean;
    readonly reviewLog: boolean;
    readonly hasPendingDeliveryTurn: boolean;
    readonly selectAgent: boolean;
    readonly listSkills: boolean;
    readonly invokeSkill: boolean;
}

export interface WorkerStartNotification {
    readonly method: "worker.start";
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly adapter: WorkerAdapterSpec;
    readonly data: RunHeadlessLoopData;
    readonly session: WorkerSessionSeed;
    readonly offers: HostBoundaryOffers;
    readonly extensions?: readonly VeraExtensionConfig[];
    readonly capabilities: WorkerHostCapabilities;
    readonly state: LoopState;
    readonly extensionToolDefinitions?: readonly RegisteredToolDefinition[];
    readonly compaction?: CompactionWireSpec;
    readonly toolResults?: ToolResultLimits;
}

export interface ClientUpdateNotification {
    readonly method: "client.update";
    readonly ownerId?: string;
    readonly update: AgentUpdate;
}

export interface ClientCommandNotification {
    readonly method: "client.command";
    readonly command: EngineCommand;
}

export interface WorkerFinishedNotification {
    readonly method: "worker.finished";
    readonly error?: string;
}
