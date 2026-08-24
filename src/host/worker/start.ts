/**
 * What a worker is told at start, and the two frames that are not
 * `host-protocol.ts` messages.
 *
 * Everything here is plain JSON. The worker receives one `start` notification
 * and nothing else is needed to run a turn: the session arrives as a header
 * plus its records, the model arrives as a module to import rather than as a
 * live adapter, and the capabilities the host offers arrive as flags rather
 * than as the presence of a function.
 */

import type { RegisteredToolDefinition } from "../../tools/types.ts";
import type { ModelReasoningEffort } from "../../model/types.ts";
import type { AgentUpdate } from "../../engine/protocol.ts";
import type { EngineCommand } from "../../engine/timeline-control.ts";
import type { HostBoundaryOffers } from "../../engine/host-boundary.ts";
import type { LoopState } from "../../engine/host-protocol.ts";
import type { RunHeadlessLoopData } from "../../engine/loop-services.ts";

/**
 * How the worker builds its model adapter.
 *
 * The adapter holds credentials and is a live object, so it is never sent. The
 * worker imports the named module and calls the named export with `options`,
 * which keeps provider construction on the side that makes the requests.
 */
export interface WorkerAdapterSpec {
    /** Absolute path or a resolvable specifier. */
    readonly module: string;
    /** Defaults to `default`. Must be a function returning a `ModelAdapter`. */
    readonly export?: string;
    readonly options?: unknown;
}

export interface WorkerSessionSeed {
    readonly path: string;
    /** Line 1 of the file, verbatim. */
    readonly header: Record<string, unknown>;
    /** Lines 2..n, in file order, verbatim. */
    readonly records: readonly Record<string, unknown>[];
}

/** Which owner calls the host will answer. Absent means the loop does it. */
import type { VeraExtensionConfig } from "../../config.ts";

export interface WorkerHostCapabilities {
    readonly updateApprovalMode: boolean;
    readonly reviewToolCall: boolean;
    /**
     * The host answers `effect.apply` for the effects whose state it holds.
     * The loop keeps its own applier for `spawn_subagent` either way.
     */
    readonly applyHostToolEffect: boolean;
    readonly requestMissingSubagentConfiguration: boolean;
    readonly applyCommittedToolEffect: boolean;
    readonly loadContextualContributions: boolean;
    readonly hooks: boolean;
    readonly reviewLog: boolean;
    readonly hasPendingDeliveryTurn: boolean;
    /** The owner answers `agent.wear`. */
    readonly wearAgent: boolean;
}

export interface WorkerStartNotification {
    readonly method: "worker.start";
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly adapter: WorkerAdapterSpec;
    readonly data: RunHeadlessLoopData;
    readonly session: WorkerSessionSeed;
    readonly offers: HostBoundaryOffers;
    /**
     * Extensions the worker loads for itself, so their tools run inside the
     * process the kill lands on.
     *
     * Absent means the host keeps executing them and the worker calls back
     * with `tool.execute`. Present means every listed extension is activated a
     * second time, in this process, which is why the owner has to ask for it
     * rather than get it by default: an extension that opens a connection
     * opens one per worker.
     */
    readonly extensions?: readonly VeraExtensionConfig[];
    readonly capabilities: WorkerHostCapabilities;
    readonly state: LoopState;
    readonly extensionToolDefinitions?: readonly RegisteredToolDefinition[];
}

/**
 * The client protocol, tunnelled.
 *
 * The design target is that `InboundCommandRouter` stays host-side and the
 * client endpoint never reaches the worker. It has not moved yet, so the
 * endpoint is worker-side and these two frames carry it. They are deliberately
 * outside `HOST_PROTOCOL_METHODS`, which names the boundary as designed.
 */
export interface ClientUpdateNotification {
    readonly method: "client.update";
    /** Present for replies owned by one attached client. */
    readonly ownerId?: string;
    readonly update: AgentUpdate;
}

export interface ClientCommandNotification {
    readonly method: "client.command";
    readonly command: EngineCommand;
}

/** The worker's last word. Written before the process exits on its own. */
export interface WorkerFinishedNotification {
    readonly method: "worker.finished";
    /** Absent when the loop returned rather than threw. */
    readonly error?: string;
}
