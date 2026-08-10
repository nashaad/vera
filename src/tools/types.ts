import type {
    ModelReasoningEffort,
    ModelSubstitution,
    ModelTool,
    ToolPresentation,
} from "../model/types.ts";
import type { ApprovalMode } from "../sdk/permissions.ts";
import type { JsonObject } from "../sdk/hooks.ts";
import type { ToolRuntime } from "./runtime.ts";

export interface ToolOutput {
    readonly kind: "output";
    readonly output: string;
    readonly isError: boolean;
    readonly presentation?: ToolPresentation;
    /**
     * Models the tool's own work ran on instead of the ones it was asked for.
     * The prose already sits in `output` so it survives replay; these rows are
     * what a client reads to render the substitution the same way it renders a
     * substitution on the session's own model.
     */
    readonly substitutions?: readonly ModelSubstitution[];
}

/**
 * Plain host-owned completion state for an effect. The engine carries this
 * inert value across its durable commit boundary but never interprets it.
 */
export interface AppliedToolEffectOutput extends ToolOutput {
    readonly afterCommit?: CommitEffect;
}

export interface CommitEffect {
    readonly key: string;
    readonly data: JsonObject;
}

export type ApplyCommittedToolEffect = (effect: CommitEffect) => Promise<void>;

export interface SpawnSubagentEffect {
    readonly type: "spawn_subagent";
    readonly description: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface SpawnAsyncSubagentEffect {
    readonly type: "spawn_async_subagent";
    readonly description: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface MessageSubagentEffect {
    readonly type: "message_subagent";
    readonly subagentId: string;
    readonly message: string;
}

export interface NotifyParentEffect {
    readonly type: "notify_parent";
    readonly message: string;
}

/**
 * Runs pool admission for exact `provider/model` identifiers. The engine
 * owner resolves it through the same admission service the client's checklist
 * uses; there is no separate agent path into the pool.
 */
export interface PoolAddEffect {
    readonly type: "pool_add";
    readonly models: readonly string[];
}

/**
 * Reads the host's live session table for the caller's workspace. It carries
 * no arguments because the workspace is the caller's own, and it stores
 * nothing: the answer only exists while the host does.
 */
export interface AgentRosterEffect {
    readonly type: "agent_roster";
}

export interface AgentSendEffect {
    readonly type: "agent_send";
    readonly to: string;
    readonly text: string;
    readonly replyTo?: number;
}

export interface AgentInboxEffect {
    readonly type: "agent_inbox";
    readonly messageId?: number;
}

export type ToolEffect =
    | SpawnSubagentEffect
    | SpawnAsyncSubagentEffect
    | MessageSubagentEffect
    | NotifyParentEffect
    | PoolAddEffect
    | AgentRosterEffect
    | AgentSendEffect
    | AgentInboxEffect;

export interface AskUserChoice {
    readonly id: string;
    readonly label: string;
    /**
     * One line saying what picking this means, shown under the label. Prose,
     * not a rendering: a choice that needs to be seen wants a preview.
     */
    readonly description?: string;
    /**
     * A concrete rendering of what this choice means: a mockup, a diff, a
     * snippet. Shown verbatim in a monospace box beside the choices, so it
     * carries no markup and the client owes it no styling.
     */
    readonly preview?: string;
}

export interface AskUserInteraction {
    readonly type: "ask_user";
    readonly question: string;
    readonly choices: readonly AskUserChoice[];
}

export interface ToolEffectContext {
    readonly approvalMode: ApprovalMode;
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface ToolEffectRequest {
    readonly kind: "effect";
    readonly effect: ToolEffect;
}

export interface ToolInteractionRequest {
    readonly kind: "interaction";
    readonly interaction: AskUserInteraction;
}

export type ApplyToolEffect = (
    effect: ToolEffect,
    signal: AbortSignal,
    context: ToolEffectContext,
) => Promise<AppliedToolEffectOutput>;

// Tools either finish with text or return a plain-data request for the engine
// owner to resolve. Live loops, stores, UI objects, and AbortControllers never
// cross this boundary.
export type ToolExecutionResult =
    | ToolOutput
    | ToolEffectRequest
    | ToolInteractionRequest;

export type PermissionInputKind = "path" | "url";
export type PermissionInputVerb = "read" | "write" | "delete";

/**
 * Declares that one of a tool's string inputs names a filesystem path or a
 * URL, so the permission engine can gate it the same way it gates bash
 * commands, instead of only structured file tools getting checked.
 */
export interface PermissionInputSpec {
    readonly field: string;
    readonly kind: PermissionInputKind;
    readonly verb: PermissionInputVerb;
}

export interface RegisteredTool {
    readonly definition: ModelTool;
    readonly parallel?: boolean;
    readonly effectType?: ToolEffect["type"];
    /** A deliberately recognized permission operation for this whole tool. */
    readonly permissionOperation?: string;
    readonly requiresUserInteraction?: boolean;
    /** Path/URL inputs to gate by permission rules. See `PermissionInputSpec`. */
    readonly permissionInputs?: readonly PermissionInputSpec[];
    execute(
        input: Readonly<Record<string, unknown>>,
        context: ToolRuntime,
        signal: AbortSignal,
    ): Promise<ToolExecutionResult>;
}
